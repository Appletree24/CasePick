import { setImmediate } from "node:timers/promises";
import {
    buildSessionProjection,
    convertToLlm,
    VERSION,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Task } from "../schema/case.ts";
import { convertMessage } from "../core/convert.ts";
import { digestOf } from "../core/digest.ts";
import type { CaseContext, RecordedEntry } from "../core/messages.ts";

export interface SessionSnapshot {
    sessionKey: string;
    branch: SessionEntry[];
    messages: RecordedEntry[];
    tools: Task["tools"];
}

// 读取只由 /casepick 主动触发。不调用 getEntries，不读取其他分支或改写会话。
export async function readSession(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<SessionSnapshot> {
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const sessionKey = `session:${digestOf(sessionId).slice(7)}`;
    const branch = ctx.sessionManager.getBranch();
    let bytes = 0;
    let count = 0;
    const messages: RecordedEntry[] = [];
    for (let index = 0; index < branch.length; index++) {
        const entry = branch[index];
        bytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
        if (entry.type === "message") count++;
        if (bytes > 20 * 1024 * 1024 || count > 2000) {
            throw new Error("当前分支超过 2000 条消息或 20 MB 的读取上限，已停止读取；本次不会用不完整历史生成案例。");
        }
        if (entry.type === "message") {
            for (const message of convertToLlm([entry.message])) {
                if (message.role === "system") continue;
                messages.push({
                    id: entry.id, message: convertMessage(message, "scan").message,
                    ...(message.role === "assistant" ? { interrupted: message.stopReason === "aborted" || message.stopReason === "error" } : {}),
                    ...(message.role === "toolResult" ? { toolError: message.isError } : {}),
                });
            }
        }
        if (index % 64 === 0) await setImmediate();
    }
    if (ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getLeafId() !== leafId) {
        throw new Error("读取期间会话发生了变化，请重新运行 /casepick。");
    }
    const active = new Set(pi.getActiveTools());
    const definitions = pi.getAllTools().filter((tool) => active.has(tool.name)).map((tool) => ({
        type: "function" as const,
        function: { name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown> },
    }));
    return {
        sessionKey,
        branch: structuredClone(branch), messages,
        // 即使当前工具为空，也不能据此断言历史截止点没有工具。
        tools: { source: "approximate", definitions },
    };
}

export function contextAt(snapshot: SessionSnapshot, cutoffEntry: string): CaseContext {
    const cutoff = snapshot.branch.find((entry) => entry.id === cutoffEntry);
    if (!cutoff || cutoff.type !== "message" || cutoff.message.role !== "assistant") {
        throw new Error("请选择当前分支中的一条 assistant 回复作为出错消息");
    }
    // 从父节点构建当时的上下文，后来的压缩和 context_edit 都不能回溯影响这道题。
    const projection = buildSessionProjection(snapshot.branch, cutoff.parentId);
    const input: RecordedEntry[] = [];
    const transforms: CaseContext["transforms"] = [];
    const limitations: CaseContext["limitations"] = [
        { field: "task.tools", status: "approximate", note: "工具定义取自扫描时的当前配置，可能与截止点时不同" },
        { field: "task.messages", status: "approximate", note: "依据已保存的会话上下文重建，未捕获其他扩展或供应商在发请求时的临时改写" },
    ];
    const systemText: string[] = [];
    const sections = new Map<string, string>();
    let systemCount = 0;
    let lateSystem = false;
    for (const projected of projection.entries) {
        const converted = convertToLlm(projected.messages);
        for (let index = 0; index < converted.length; index++) {
            const message = converted[index];
            if (message.role === "system") {
                systemCount++;
                lateSystem ||= input.length > 0;
                const content = typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n");
                if (content) systemText.push(content);
                for (const [name, text] of Object.entries(message.sections ?? {})) {
                    if (text === null) sections.delete(name);
                    else sections.set(name, text);
                }
                continue;
            }
            const result = convertMessage(message, `task.messages[${input.length}]`);
            input.push({ id: `${projected.sourceEntry.id}:${index}`, message: result.message });
            transforms.push(...result.transforms);
        }
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
        const raw = snapshot.branch.find((candidate) => candidate.id === entry.id);
        if (raw?.type === "message") {
            for (const message of convertToLlm([raw.message])) {
                if (message.role !== "system") transforms.push(...convertMessage(message, `diagnostic.followup[${followup.length - 1}]`).transforms);
            }
        }
    }
    const approximateSystem = systemCount > 1 || lateSystem;
    const system: Task["system"] = systemCount === 0 ? { status: "missing", content: null }
        : { status: approximateSystem ? "approximate" : "captured", content: [...systemText, ...sections.values()].filter(Boolean).join("\n\n") };
    if (system.status !== "captured") limitations.push({
        field: "task.system", status: system.status,
        note: system.status === "missing" ? "会话没有保存截止点时的系统提示，未使用现在的提示代替"
            : "会话中途更新过系统提示，已合并为截止点时的提示内容；单个 system 字段无法保留更新的时间位置",
    });
    if (transforms.some((transform) => transform.type === "omit_image")) limitations.push({
        field: "task.messages", status: "unrecoverable", note: "图片以省略标记替代；本案例不能用于判定依赖图片内容的要求",
    });
    if (input.some((entry) => entry.message.role === "assistant" && entry.message.tool_calls?.length) || output.message.tool_calls?.length) {
        limitations.push({ field: "tool_calls.arguments", status: "approximate", note: "Pi 保存的是已解析的参数对象，导出为 JSON 字符串；原始 JSON 的空白与键编码不可恢复" });
    }
    return {
        sessionKey: snapshot.sessionKey, cutoffEntry, hostVersion: VERSION, input,
        observed: output.message, followup, system, tools: structuredClone(snapshot.tools), limitations, transforms,
    };
}
