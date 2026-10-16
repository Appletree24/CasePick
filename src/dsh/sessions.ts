import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ContentBlock, Message as NativeMessage } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-session-query";
import type {} from "@deepseek-ai/dsh-session-reference/types";
import { deriveEventMessage, foldRequestHeader, foldSurface, isAppendSurfaceEvent, SessionId, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import type { SessionSource } from "../host.ts";
import type { CaseContext, RecordedEntry } from "../core/messages.ts";
import type { Message, ToolCall } from "../schema/case.ts";
import { sessionKeyOf, type SessionSnapshot } from "../pi/read-session.ts";
import type { LoadedSession, SourceReference } from "../pi/sources.ts";

const locator = (id: string) => `dsh:${id}`;
const eventId = (event: SessionEvent) => `dsh:${event.seq}`;
const invalidSessionId = /[\/\\\u0000-\u001f]/;

// The receiving agent, not another live agent or a newly resumed session, owns this cut.
export function createDshSources(ctx: Context, agent: Agent, signal: AbortSignal): SessionSource {
    const currentId = locator(agent.session.header.id);
    const loaded = (header: SessionHeader, snapshot: SessionSnapshot): LoadedSession => ({
        key: snapshot.sessionKey, id: locator(header.id), file: locator(header.id),
        label: `DSH ${header.id.slice(0, 8)}${header.cwd ? ` · ${header.cwd}` : ""}`,
        snapshot, external: locator(header.id) !== currentId,
    });
    return {
        async readCurrent() {
            signal.throwIfAborted();
            return snapshotOf(agent.session.header, agent.session.snapshotEvents(), ctx, signal);
        },
        current(snapshot) { return loaded(agent.session.header, snapshot); },
        async list() {
            signal.throwIfAborted();
            const records = await ctx.sessionQuery.listSessions(signal);
            signal.throwIfAborted();
            return records.map(({ header }) => ({
                id: locator(header.id), path: locator(header.id), cwd: header.cwd ?? "",
                label: `DSH ${header.id.slice(0, 8)}${header.cwd ? ` · ${header.cwd}` : ""}`,
                created: new Date(header.createdAt),
            }));
        },
        async load(location) {
            signal.throwIfAborted();
            const id = location.startsWith("dsh:") ? location.slice(4) : location;
            if (!id || id === "." || id === ".." || invalidSessionId.test(id)) throw new Error(`不是 DSH 会话 ID 或定位符：${location}`);
            const observation = await ctx.sessionQuery.observeSession(SessionId(id), { signal, projectionMode: "none" });
            try {
                return loaded(observation.header, snapshotOf(observation.header, observation.events, ctx, signal));
            } finally {
                observation[Symbol.dispose]();
            }
        },
    };
}

function snapshotOf(header: SessionHeader, source: readonly SessionEvent[], ctx: Context, signal: AbortSignal): SessionSnapshot {
    let bytes = 0;
    let count = 0;
    for (const event of source) {
        signal.throwIfAborted();
        bytes += Buffer.byteLength(JSON.stringify(event), "utf8");
        if (isAppendSurfaceEvent(event)) count++;
        if (bytes > 20 * 1024 * 1024 || count > 2000) throw new Error("DSH 会话超过 2000 条消息或 20 MB 的读取上限；不会使用不完整历史生成案例。");
    }
    // Detach query leases and source-owned arrays; later appends/replacements cannot affect a selected candidate.
    const events = structuredClone(source);
    const projections = [...ctx.sessions.messageProjections];
    foldSurface(events, projections);
    const messages: RecordedEntry[] = [];
    const references: SourceReference[] = [];
    for (const event of events) {
        if (!isAppendSurfaceEvent(event)) continue;
        const message = deriveEventMessage(event);
        if (!message || message.role === "system" || message.role === "developer") continue;
        const converted = convert(message, "scan", ctx);
        messages.push({ id: eventId(event), message: converted.message,
            ...(event.type === "assistant/message" ? { interrupted: event.data.interrupted === true } : {}),
            ...(converted.toolError === undefined ? {} : { toolError: converted.toolError }),
        });
        if (message.source.kind === "session-reference") {
            for (const reference of message.source.references) references.push({
                entry: eventId(event), sessionId: locator(reference.sessionId),
                // The native capture identifies a watermark, not an exact originating reply.
                preview: `${reference.label} · 截至 ${reference.capturedThroughSeq ?? "空会话"}${reference.truncated || reference.compacted ? " · 摘录" : ""}`,
            });
        }
    }
    const snapshot: SessionSnapshot = {
        sessionKey: sessionKeyOf(locator(header.id)),
        branch: events.map((event) => ({ id: eventId(event), type: event.type, timestamp: event.time, content: event.data })),
        messages, tools: toolsAt(events), sourceReferences: references,
        contextAt(cutoffEntry) {
            const cutoff = events.find((event) => eventId(event) === cutoffEntry);
            if (!cutoff || cutoff.type !== "assistant/message" || !isAppendSurfaceEvent(cutoff) || !deriveEventMessage(cutoff)) {
                throw new Error("请选择 DSH 会话中的一条原始 assistant 回复作为出错消息");
            }
            const prefix = events.slice(0, cutoff.seq);
            const surface = foldSurface(prefix, projections);
            const input: RecordedEntry[] = [];
            const transforms: CaseContext["transforms"] = [];
            const limitations: CaseContext["limitations"] = [{ field: "task.messages", status: "approximate", note: "从 DSH 原生日志重建宿主请求历史；不包含供应商私有指令或请求中间件的临时改写" }];
            const systems: string[] = [];
            let systemRecorded = false;
            let lateSystem = false;
            let fileProjection = false;
            let toolUpdates = false;
            let developerInstructions = false;
            for (const seq of surface.nodes) {
                const event = prefix[seq];
                if (event.type === "system/message") systemRecorded = true;
                const message = deriveEventMessage(event, surface.projectedMessages);
                if (!message) continue;
                fileProjection ||= message.content.some((block) => block.type === "file");
                if (message.role === "developer") {
                    const instructions = message.content.filter((block) => block.type !== "tool-addition" && block.type !== "tool-removal");
                    toolUpdates ||= instructions.length !== message.content.length;
                    if (instructions.length) {
                        developerInstructions = true;
                        systemRecorded = true;
                        systems.push(blockText(instructions, "task.system", transforms, ctx));
                    }
                    continue;
                }
                if (message.role === "system") {
                    lateSystem ||= input.length > 0;
                    systems.push(blockText(message.content, "task.system", transforms, ctx));
                } else {
                    const converted = convert(message, `task.messages[${input.length}]`, ctx);
                    input.push({ id: eventId(event), message: converted.message, ...(converted.toolError === undefined ? {} : { toolError: converted.toolError }) });
                    transforms.push(...converted.transforms);
                }
            }
            const observed = convert(cutoff.data.message, "diagnostic.observed", ctx);
            if (observed.message.role !== "assistant") throw new Error("出错消息不是 assistant 回复");
            transforms.push(...observed.transforms);
            const position = messages.findIndex((entry) => entry.id === cutoffEntry);
            const followup: Message[] = [];
            for (const entry of messages.slice(position + 1)) {
                if (entry.message.role === "assistant") break;
                const raw = events.find((event) => eventId(event) === entry.id)!;
                const converted = convert(deriveEventMessage(raw)!, `diagnostic.followup[${followup.length}]`, ctx);
                followup.push(converted.message);
                transforms.push(...converted.transforms);
            }
            const system: CaseContext["system"] = !systemRecorded ? { status: "missing", content: null }
                : { status: systems.length > 1 || lateSystem || developerInstructions ? "approximate" : "captured", content: systems.join("\n\n") };
            if (system.status !== "captured") limitations.push({ field: "task.system", status: system.status,
                note: system.status === "missing" ? "截止点前未记录系统提示；未使用当前提示替代" : "历史系统提示和指令已合并，无法在单个 system 字段保留原来的角色层级或更新位置" });
            if (developerInstructions) limitations.push({ field: "task.system", status: "approximate", note: "DSH developer 指令已合并到 system；案例格式不能保留 developer 角色的优先级和原来的消息位置" });
            const tools = toolsAt(prefix);
            if (toolUpdates && tools.source === "approximate") throw new Error("DSH developer 工具增删记录缺少截止点 request/header，无法确定当前工具定义");
            if (tools.source === "approximate") limitations.push({ field: "task.tools", status: "missing", note: "截止点前没有原生 request/header，未使用当前工具配置替代" });
            if (toolUpdates) limitations.push({ field: "task.messages", status: "approximate", note: "DSH developer 工具增删记录不能表示为案例消息角色；仅保留截止点 request/header 的当前工具定义，不复原供应商的历史工具声明位置" });
            if (foldRequestHeader(prefix)?.tools?.some((tool) => tool.deferLoading)) limitations.push({ field: "task.tools", status: "approximate", note: "已捕获原生工具定义，但案例格式不能保留 DSH deferLoading 声明语义" });
            if (transforms.some((item) => item.type === "omit_image")) limitations.push({ field: "task.messages", status: "unrecoverable", note: "图片内容以省略标记表示，无法复原历史供应商图片字节" });
            if (fileProjection) limitations.push({ field: "task.messages", status: "approximate", note: "DSH 文件引用按当前环境的原生模型句柄投影；未捕获历史请求路径或附件字节" });
            return { sessionKey: snapshot.sessionKey, cutoffEntry, hostVersion: `DSH/session-format-${header.version}`, input,
                observed: observed.message, followup, system, tools, limitations, transforms };
        },
    };
    return snapshot;
}

function toolsAt(events: readonly SessionEvent[]): CaseContext["tools"] {
    const header = foldRequestHeader(events);
    if (!header) return { source: "approximate" };
    if (!header.tools?.length) return { source: "none", definitions: [] };
    return { source: "captured", definitions: header.tools.map(({ name, description, parameters }) => ({
        type: "function", function: { name, description, parameters: structuredClone(parameters) },
    })) };
}

function blockText(blocks: readonly ContentBlock[], target: string, transforms: CaseContext["transforms"], ctx: Context): string {
    return blocks.map((block): string => {
        switch (block.type) {
            case "text": return block.text;
            case "reasoning": transforms.push({ type: "drop_thinking", target, detail: "不保留原生 reasoning 内容" }); return "";
            case "image": transforms.push({ type: "omit_image", target, detail: "DSH 持久化图片引用无法在文本案例中复原" }); return "[图片已省略]";
            case "file": return ctx.llm.fileRequestText(block.attachment);
            default: throw new Error(`无法无损导出 DSH ${block.type} 内容块到文本字段`);
        }
    }).join("");
}

function convert(message: NativeMessage, target: string, ctx: Context): { message: Message; transforms: CaseContext["transforms"]; toolError?: boolean } {
    const transforms: CaseContext["transforms"] = [];
    if (message.role === "system" || message.role === "developer") throw new Error("系统或 developer 消息必须单独处理");
    if (message.role === "tool") {
        if (message.toolCallId !== message.source.callId) throw new Error("DSH 工具结果的调用关联无效");
        return { message: { role: "tool", tool_call_id: message.toolCallId, content: blockText(message.content, target, transforms, ctx) }, transforms, toolError: message.isError === true };
    }
    const calls: ToolCall[] = [];
    const visible: ContentBlock[] = [];
    for (const block of message.content) {
        if (block.type === "tool-call" && message.role === "assistant") calls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments } });
        else visible.push(block);
    }
    const content = blockText(visible, target, transforms, ctx);
    const converted: Message = message.role === "assistant"
        ? calls.length ? { role: "assistant", content: content || null, tool_calls: calls } : { role: "assistant", content }
        : { role: "user", content };
    return { message: converted, transforms };
}
