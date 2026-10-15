import { setImmediate } from "node:timers/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PiSessionSDK, WorkflowAPI, WorkflowContext } from "../host.ts";
import type { SourceReference } from "./sources.ts";
import type { Task } from "../schema/case.ts";
import { convertMessage, type RecordedMessage } from "../core/convert.ts";
import { digestOf } from "../core/digest.ts";
import type { CaseContext, RecordedEntry } from "../core/messages.ts";

// OMP 的兼容加载器将 Pi 包引用绑定到宿主实现；developer 是 OMP 额外的指令角色。
type HostMessage = (RecordedMessage & { stopReason?: string; isError?: boolean }) |
    (({ role: "system" } | { role: "developer" }) & {
        content: string | { type: "text"; text: string }[];
        sections?: Record<string, string | null>;
    });

export interface SnapshotEntry {
    id: string;
    type: string;
    timestamp?: string | number;
    content?: unknown;
}

export interface SessionSnapshot {
    sessionKey: string;
    branch: SnapshotEntry[];
    messages: RecordedEntry[];
    tools: Task["tools"];
    contextAt(cutoffEntry: string): CaseContext;
    sourceReferences?: SourceReference[];
}

export function sessionKeyOf(sessionId: string): string {
    return `session:${digestOf(sessionId).slice(7)}`;
}

// 读取只由 /casepick 主动触发。不调用 getEntries，不读取其他分支或改写会话。
export async function readSession(ctx: WorkflowContext, pi: WorkflowAPI): Promise<SessionSnapshot> {
    if (ctx.sources) return ctx.sources.readCurrent();
    if (!ctx.sessionManager) throw new Error("宿主没有提供会话读取接口");
    if (!ctx.piSdk) throw new Error("Pi/OMP 入口没有提供会话 SDK");
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const snapshot = await snapshotFromBranch(ctx.sessionManager.getBranch(), sessionKeyOf(sessionId), currentTools(pi), ctx.piSdk);
    if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId) {
        throw new Error("读取期间会话发生了变化，请重新运行 /casepick。");
    }
    return snapshot;
}

// 工具定义只能取扫描时的当前配置，标为近似。
export function currentTools(pi: WorkflowAPI): Task["tools"] {
    if (!pi.getActiveTools || !pi.getAllTools) throw new Error("Pi/OMP 宿主没有提供工具目录接口");
    const active = new Set(pi.getActiveTools());
    const definitions = pi.getAllTools().filter((tool) => active.has(tool.name)).map((tool) => {
        // Pi 使用普通 TypeBox 对象；OMP omptype schema 是可调用对象，必须先导出 JSON Schema。
        const schema = tool.parameters as { toJsonSchema?: () => Record<string, unknown> };
        const parameters = typeof schema.toJsonSchema === "function" ? schema.toJsonSchema() : schema;
        return {
            type: "function" as const,
            function: { name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(parameters)) as Record<string, unknown> },
        };
    });
    // 即使当前工具为空，也不能据此断言历史截止点没有工具。
    return { source: "approximate", definitions };
}

// 把一条分支转换成快照。当前会话和用户选定的其他会话文件共用，读取上限一致。
export async function snapshotFromBranch(branch: SessionEntry[], sessionKey: string, tools: Task["tools"], sdk: PiSessionSDK): Promise<SessionSnapshot> {
    let bytes = 0;
    let count = 0;
    const messages: RecordedEntry[] = [];
    for (let index = 0; index < branch.length; index++) {
        const entry = branch[index];
        bytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
        if (entry.type === "message") count++;
        if (bytes > 20 * 1024 * 1024 || count > 2000) {
            throw new Error("分支超过 2000 条消息或 20 MB 的读取上限，已停止读取；本次不会用不完整历史生成案例。");
        }
        if (entry.type === "message") {
            const converted: HostMessage[] = sdk.convertToLlm([entry.message]);
            for (const message of converted) {
                if (message.role === "system" || message.role === "developer") continue;
                messages.push({
                    id: entry.id, message: convertMessage(message, "scan").message,
                    ...(message.role === "assistant" ? { interrupted: message.stopReason === "aborted" || message.stopReason === "error" } : {}),
                    ...(message.role === "toolResult" ? { toolError: message.isError } : {}),
                });
            }
        }
        if (index % 64 === 0) await setImmediate();
    }
    const frozen = structuredClone(branch);
    const snapshot: SessionSnapshot = {
        sessionKey, branch: frozen, messages, tools,
        contextAt: (cutoffEntry) => piContextAt(snapshot, frozen, sdk, cutoffEntry),
    };
    return snapshot;
}

export function contextAt(snapshot: SessionSnapshot, cutoffEntry: string): CaseContext {
    return snapshot.contextAt(cutoffEntry);
}

function piContextAt(snapshot: SessionSnapshot, branch: SessionEntry[], sdk: PiSessionSDK, cutoffEntry: string): CaseContext {
    const cutoff = branch.find((entry) => entry.id === cutoffEntry);
    if (!cutoff || cutoff.type !== "message" || cutoff.message.role !== "assistant") {
        throw new Error("请选择当前分支中的一条 assistant 回复作为出错消息");
    }
    // 两个宿主都提供此接口；压缩、Pi context_edit 和 OMP reset 由当前宿主解释。
    // 只重建父节点，不能用当前叶子的上下文，否则后续纠正会泄漏进题目。
    const context = sdk.buildSessionContext(branch, cutoff.parentId);
    const input: RecordedEntry[] = [];
    const transforms: CaseContext["transforms"] = [];
    const limitations: CaseContext["limitations"] = [
        { field: "task.tools", status: "approximate", note: "工具定义取自扫描时的当前配置，可能与截止点时不同" },
        { field: "task.messages", status: "approximate", note: "依据已保存的会话上下文重建，未捕获其他扩展或供应商在发请求时的临时改写" },
    ];
    // OMP 的 session_init 记录基础提示，不保证包含逐轮 hook 的临时覆盖。
    // 只读截止点之前最新的一份；没有记录时不能拿现在的系统提示代替。
    let recordedBase: string | undefined;
    for (const entry of branch) {
        if (entry.id === cutoffEntry) break;
        const init = entry as { type: string; systemPrompt?: string | string[] };
        if (init.type === "session_init") {
            recordedBase = Array.isArray(init.systemPrompt) ? init.systemPrompt.join("\n\n") : init.systemPrompt;
        }
    }
    const systemText: string[] = recordedBase === undefined ? [] : [recordedBase];
    const sections = new Map<string, string>();
    let systemCount = recordedBase === undefined ? 0 : 1;
    let developerCount = 0;
    let lateSystem = false;
    const converted: HostMessage[] = sdk.convertToLlm(context.messages);
    for (const [index, message] of converted.entries()) {
        if (message.role === "system" || message.role === "developer") {
            systemCount++;
            if (message.role === "developer") developerCount++;
            lateSystem ||= input.length > 0;
            const content = typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n");
            if (content) systemText.push(content);
            if (message.role === "system") {
                for (const [name, text] of Object.entries(message.sections ?? {})) {
                    if (text === null) sections.delete(name);
                    else sections.set(name, text);
                }
            }
            continue;
        }
        const result = convertMessage(message, `task.messages[${input.length}]`);
        // 重建消息可能来自压缩摘要，没有一一对应的 entry；这里是快照内 ID，不冒充原 entry。
        input.push({ id: `context:${cutoffEntry}:${index}`, message: result.message });
        transforms.push(...result.transforms);
    }
    const output = convertMessage(cutoff.message, "diagnostic.observed");
    if (output.message.role !== "assistant") throw new Error("出错消息不是 assistant 回复");
    transforms.push(...output.transforms);

    // 只保留到下一条 assistant 之前的工具结果和用户纠正，不收集后续修正答案。
    const position = snapshot.messages.findIndex((entry) => entry.id === cutoffEntry);
    const followup: CaseContext["followup"] = [];
    for (const entry of snapshot.messages.slice(position + 1)) {
        if (entry.message.role === "assistant") break;
        followup.push(structuredClone(entry.message));
        const raw = branch.find((candidate) => candidate.id === entry.id);
        if (raw?.type === "message") {
            const converted: HostMessage[] = sdk.convertToLlm([raw.message]);
            for (const message of converted) {
                if (message.role !== "system" && message.role !== "developer") transforms.push(...convertMessage(message, `diagnostic.followup[${followup.length - 1}]`).transforms);
            }
        }
    }
    const approximateSystem = recordedBase !== undefined || developerCount > 0 || systemCount > 1 || lateSystem;
    const system: Task["system"] = systemCount === 0 ? { status: "missing", content: null }
        : { status: approximateSystem ? "approximate" : "captured", content: [...systemText, ...sections.values()].filter(Boolean).join("\n\n") };
    if (system.status !== "captured") limitations.push({
        field: "task.system", status: system.status,
        note: system.status === "missing" ? "会话没有保存截止点时的系统提示，未使用现在的提示代替"
            : "已合并记录的基础提示和指令消息；无法保证逐轮 hook 覆盖、developer 层级或提示更新时间位置与原请求完全一致",
    });
    if (transforms.some((transform) => transform.type === "omit_image")) limitations.push({
        field: "task.messages", status: "unrecoverable", note: "图片以省略标记替代；本案例不能用于判定依赖图片内容的要求",
    });
    if (input.some((entry) => entry.message.role === "assistant" && entry.message.tool_calls?.length) || output.message.tool_calls?.length) {
        limitations.push({ field: "tool_calls.arguments", status: "approximate", note: "宿主保存的是已解析的参数对象，导出为 JSON 字符串；原始 JSON 的空白与键编码不可恢复" });
    }
    return {
        sessionKey: snapshot.sessionKey, cutoffEntry, hostVersion: sdk.VERSION, input,
        observed: output.message, followup, system, tools: structuredClone(snapshot.tools), limitations, transforms,
    };
}
