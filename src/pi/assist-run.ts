// 模型辅助的执行流程：解析模型 → 构造提示词 → 脱敏 → 外发确认 → 逐个请求 → 核对。
// 核对不过的建议丢弃并展示原因，不重试。

import type { WorkflowContext } from "../host.ts";
import {
    chunkEntries, evidencePrompt, parseJsonObject, slicePrompt, verifyEvidence, verifySlices,
    type AssistEntry, type EvidenceProposal, type Prompt, type Rejected, type SliceProposal,
} from "../core/assist.ts";
import { loadConfig, type Config } from "../store/config.ts";
import { callModel, confirmSend, prepareRequests, resolveDraftModel } from "./model.ts";
import type { DraftModel, ModelReply, PreparedRequest } from "./model.ts";
import { settingsFor } from "./plugin-settings.ts";
import { showText } from "./ui.ts";

interface Prepared {
    config: Config;
    draft: DraftModel;
    debug: boolean;
}

async function prepare(ctx: WorkflowContext): Promise<Prepared | undefined> {
    const config = await loadConfig();
    const plugin = await settingsFor(ctx);
    for (const warning of plugin.warnings) ctx.ui.notify(warning, "warning");
    const resolved = resolveDraftModel(ctx, config, plugin.overrides);
    if (!resolved.ok) {
        ctx.ui.notify(resolved.reason, "warning");
        return undefined;
    }
    return { config, draft: resolved.value, debug: plugin.overrides.debug ?? config.drafting.debug };
}

interface DebugOutcome {
    status: string;
    reply?: ModelReply;
    parsed?: unknown;
    verification?: { accepted: number; rejected: Rejected[] };
    error?: string;
}

// 仅在当前调用中展示脱敏后的请求和原始回复；不持久化内容、不收集调用凭据。
async function showDebug(ctx: WorkflowContext, purpose: string, index: number, total: number,
    draft: DraftModel, request: PreparedRequest, outcome: DebugOutcome): Promise<void> {
    ctx.ui.setStatus("casepick", undefined);
    const summary = `${purpose} Debug · 请求 ${index + 1}/${total}\n${outcome.status}\n${draft.key} · 思考 ${draft.reasoning ?? "off"} · 输出上限 ${draft.maxOutputTokens} · 超时 ${draft.timeoutSeconds}s\n停止原因：${outcome.reply?.stopReason ?? "未收到回复"}；用量：${outcome.reply?.usage ? `${outcome.reply.usage.input}/${outcome.reply.usage.output} tokens` : "未知"}\n仅在当前界面展示；原始回复可能含敏感内容，不保存日志。`;
    const panels = ["请求（脱敏后）", "原始回复", "解析结果", "核对结果", "继续"];
    while (true) {
        const choice = await ctx.ui.select(summary, panels);
        if (!choice || choice === "继续") return;
        let content: string;
        if (choice === panels[0]) {
            content = `【系统提示】\n${request.prompt.system}\n\n【消息】\n${request.prompt.user}\n\n【脱敏命中】\n${JSON.stringify(request.hits, null, 2)}`;
        } else if (choice === panels[1]) {
            content = outcome.reply?.text ?? "未收到回复。";
        } else if (choice === panels[2]) {
            content = outcome.parsed === undefined ? `未完成解析。\n${outcome.error ?? ""}` : JSON.stringify(outcome.parsed, null, 2);
        } else {
            content = outcome.verification
                ? `通过核对：${outcome.verification.accepted}；被丢弃：${outcome.verification.rejected.length}\n${JSON.stringify(outcome.verification.rejected, null, 2)}${outcome.verification.accepted === 0 && outcome.verification.rejected.length === 0 ? "\n模型返回空候选列表；这不表示已证明会话没有问题，当前回复未提供空结果原因。" : ""}`
                : `未执行核对。\n${outcome.error ?? ""}`;
        }
        await showText(ctx.ui, `${purpose} Debug · ${choice}`, content);
    }
}

async function run<T>(ctx: WorkflowContext, purpose: string, prompts: Prompt[],
    verify: (reply: unknown, index: number) => { accepted: T[]; rejected: Rejected[] }): Promise<{ accepted: T[]; rejected: Rejected[] } | undefined> {
    const prepared = await prepare(ctx);
    if (!prepared) return undefined;
    const requests = prepareRequests(prompts);
    if (!await confirmSend(ctx, prepared.config, prepared.draft, requests, purpose)) return undefined;
    const accepted: T[] = [];
    const rejected: Rejected[] = [];
    let input = 0;
    let output = 0;
    let unknownUsage = false;
    try {
        for (const [index, request] of requests.entries()) {
            ctx.ui.setStatus("casepick", `CasePick：${purpose}，${prepared.draft.label}，第 ${index + 1} / ${requests.length} 个请求…`);
            let reply;
            try {
                reply = await callModel(ctx, prepared.draft, request.prompt);
            } catch (error) {
                ctx.ui.notify(`第 ${index + 1} 个请求失败，剩余 ${requests.length - index - 1} 个不再发送：${error instanceof Error ? error.message : String(error)}`, "error");
                if (prepared.debug) await showDebug(ctx, purpose, index, requests.length, prepared.draft, request,
                    { status: "模型调用失败", error: error instanceof Error ? error.message : String(error) });
                break;
            }
            if (reply.usage) { input += reply.usage.input; output += reply.usage.output; } else unknownUsage = true;
            let parsed: unknown;
            try { parsed = parseJsonObject(reply.text); } catch (error) {
                rejected.push({ item: reply.text.slice(0, 200), reason: `第 ${index + 1} 个回复无法解析：${error instanceof Error ? error.message : String(error)}` });
                if (prepared.debug) await showDebug(ctx, purpose, index, requests.length, prepared.draft, request,
                    { status: "回复无法解析为 JSON", reply, error: error instanceof Error ? error.message : String(error) });
                continue;
            }
            const result = verify(parsed, index);
            accepted.push(...result.accepted);
            rejected.push(...result.rejected);
            if (prepared.debug) await showDebug(ctx, purpose, index, requests.length, prepared.draft, request, {
                status: result.accepted.length === 0 && result.rejected.length === 0 ? "模型返回空候选列表" : "核对完成",
                reply, parsed, verification: { accepted: result.accepted.length, rejected: result.rejected },
            });
        }
    } finally {
        ctx.ui.setStatus("casepick", undefined);
    }
    ctx.ui.notify(`${purpose}完成：${accepted.length} 条通过核对，${rejected.length} 条被丢弃。用量 输入 ${input} / 输出 ${output} tokens${unknownUsage ? "（部分请求未返回用量）" : ""}。`, "info");
    if (rejected.length && await ctx.ui.confirm("查看被丢弃的建议？", `${rejected.length} 条建议没有通过核对，没有使用。`)) {
        await showText(ctx.ui, "被丢弃的建议", rejected.map((item) => `原因：${item.reason}\n内容：${JSON.stringify(item.item).slice(0, 300)}`).join("\n\n"));
    }
    return { accepted, rejected };
}

export async function proposeEvidence(ctx: WorkflowContext, issueTitle: string, entries: AssistEntry[]): Promise<EvidenceProposal[] | undefined> {
    const chunks = chunkEntries(entries);
    const result = await run(ctx, "找证据", chunks.map((chunk) => evidencePrompt(issueTitle, chunk)), (reply, index) => verifyEvidence(reply, chunks[index]));
    return result?.accepted;
}

// entries 是同一会话主分支上的消息。分段时带上前一段末尾的消息，避免出处落在上一段。
export async function proposeSlices(ctx: WorkflowContext, issueTitle: string, entries: AssistEntry[], fixedCutoff?: string): Promise<SliceProposal[] | undefined> {
    const chunks = fixedCutoff ? [entries] : chunkEntries(entries, 100_000, 30);
    const result = await run(ctx, fixedCutoff ? "起草要求" : "提议切片", chunks.map((chunk) => slicePrompt(issueTitle, chunk, { cutoff: fixedCutoff })),
        (reply, index) => verifySlices(reply, chunks[index], fixedCutoff));
    if (!result) return undefined;
    // 分段重叠可能产生重复提议：同一截止点、同一引文只保留一条。
    const seen = new Set<string>();
    return result.accepted.filter((proposal) => {
        const key = `${proposal.cutoff.entry}|${proposal.basis}|${proposal.norm ?? ""}|${proposal.quote}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
