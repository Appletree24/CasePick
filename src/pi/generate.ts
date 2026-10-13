import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CaseDocument } from "../schema/case.ts";
import { findCandidates } from "../core/candidates.ts";
import { draftCase } from "../core/draft-rule.ts";
import type { CaseContext } from "../core/messages.ts";
import { appendCase, casesPath } from "../store/cases.ts";
import { contextAt, readSession } from "./read-session.ts";
import { pick, reviewCase } from "./ui.ts";

export async function generateCases(pi: ExtensionAPI, ctx: ExtensionCommandContext, version: string): Promise<void> {
    if (!ctx.isIdle()) {
        ctx.ui.notify("请等当前回复结束后再运行 /casepick，以便读取完整消息。", "warning");
        return;
    }
    const path = casesPath();
    ctx.ui.setStatus("casepick", "CasePick：正在读取当前分支…");
    try {
        const snapshot = await readSession(ctx, pi);
        const candidates = findCandidates(snapshot.messages);
        if (!candidates.length) {
            ctx.ui.notify("当前分支还没有可整理的 assistant 回复。", "info");
            return;
        }
        const drafts = new Map<string, { context: CaseContext; doc: CaseDocument }>();
        const saved = new Set<string>();
        while (true) {
            const remaining = candidates.filter((candidate) => !saved.has(candidate.entryId));
            if (!remaining.length) break;
            const suggested = remaining.filter((candidate) => candidate.signals.length);
            ctx.ui.setStatus("casepick", `CasePick：${suggested.length} 个候选，已保存 ${saved.size} 条`);
            const mode = await ctx.ui.select(`已读取当前分支 ${snapshot.messages.length} 条消息。\n选择一条出错回复，原要求必须在它之前出现。`, [
                ...(suggested.length ? [`审阅疑似犯错（${suggested.length} 条）`] : []),
                `手动选择历史回复（${remaining.length} 条）`, "结束",
            ]);
            if (!mode || mode === "结束") break;
            const list = mode.startsWith("审阅") ? suggested : remaining;
            const candidate = await pick(ctx.ui, "选择原出错回复（最近的在前）", [...list].reverse(),
                (item) => `消息 #${item.messageIndex + 1} ${item.signals.length ? `[${item.signals.join("、")}] ` : ""}${item.preview}`);
            if (!candidate) continue;
            let draft = drafts.get(candidate.entryId);
            if (!draft) {
                try {
                    const context = contextAt(snapshot, candidate.entryId);
                    draft = { context, doc: draftCase(context, version) };
                    drafts.set(candidate.entryId, draft);
                } catch (error) {
                    ctx.ui.notify(`无法整理这条回复：${error instanceof Error ? error.message : String(error)}`, "error");
                    continue;
                }
            }
            if (await reviewCase(ctx.ui, draft.doc, draft.context, path, (doc) => appendCase(doc, path))) saved.add(candidate.entryId);
        }
        ctx.ui.notify(saved.size ? `本次已生成并保存 ${saved.size} 条案例：\n${path}` : "本次未保存案例。", "info");
    } finally {
        ctx.ui.setStatus("casepick", undefined);
    }
}
