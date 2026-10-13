// 模型辅助的执行流程：解析模型 → 构造提示词 → 脱敏 → 外发确认 → 逐个请求 → 核对。
// 核对不过的建议丢弃并展示原因，不重试。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
    chunkEntries, evidencePrompt, parseJsonObject, slicePrompt, verifyEvidence, verifySlices,
    type AssistEntry, type EvidenceProposal, type Prompt, type Rejected, type SliceProposal,
} from "../core/assist.ts";
import { loadConfig, type Config } from "../store/config.ts";
import { callModel, confirmSend, prepareRequests, resolveDraftModel, type DraftModel } from "./model.ts";
import { showText } from "./ui.ts";

interface Prepared {
    config: Config;
    draft: DraftModel;
}

async function prepare(ctx: ExtensionCommandContext): Promise<Prepared | undefined> {
    const config = await loadConfig();
    const resolved = resolveDraftModel(ctx, config);
    if (!resolved.ok) {
        ctx.ui.notify(resolved.reason, "warning");
        return undefined;
    }
    return { config, draft: resolved.value };
}

async function run<T>(ctx: ExtensionCommandContext, purpose: string, prompts: Prompt[],
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
                reply = await callModel(ctx, prepared.config, prepared.draft, request.prompt);
            } catch (error) {
                ctx.ui.notify(`第 ${index + 1} 个请求失败，剩余 ${requests.length - index - 1} 个不再发送：${error instanceof Error ? error.message : String(error)}`, "error");
                break;
            }
            if (reply.usage) { input += reply.usage.input; output += reply.usage.output; } else unknownUsage = true;
            let parsed: unknown;
            try { parsed = parseJsonObject(reply.text); } catch (error) {
                rejected.push({ item: reply.text.slice(0, 200), reason: `第 ${index + 1} 个回复无法解析：${error instanceof Error ? error.message : String(error)}` });
                continue;
            }
            const result = verify(parsed, index);
            accepted.push(...result.accepted);
            rejected.push(...result.rejected);
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

export async function proposeEvidence(ctx: ExtensionCommandContext, issueTitle: string, entries: AssistEntry[]): Promise<EvidenceProposal[] | undefined> {
    const chunks = chunkEntries(entries);
    const result = await run(ctx, "找证据", chunks.map((chunk) => evidencePrompt(issueTitle, chunk)), (reply, index) => verifyEvidence(reply, chunks[index]));
    return result?.accepted;
}

// entries 是同一会话主分支上的消息。分段时带上前一段末尾的消息，避免出处落在上一段。
export async function proposeSlices(ctx: ExtensionCommandContext, issueTitle: string, entries: AssistEntry[], fixedCutoff?: string): Promise<SliceProposal[] | undefined> {
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
