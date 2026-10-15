import type { WorkflowAPI, WorkflowContext } from "../host.ts";
import { findCandidates } from "../core/candidates.ts";
import { appendCase, casesPath } from "../store/cases.ts";
import { manageIssues } from "./issues-ui.ts";
import { readSession } from "./read-session.ts";
import { buildSlice, type SliceDraft } from "./slice.ts";
import { currentSession } from "./sources.ts";
import { pick, reviewCase } from "./ui.ts";

export async function generateCases(pi: WorkflowAPI, ctx: WorkflowContext, version: string): Promise<void> {
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
            const choice = await ctx.ui.select("当前分支还没有可整理的 assistant 回复。", ["整理长程问题（跨多轮、多个会话）", "结束"]);
            if (choice?.startsWith("整理长程问题")) await manageIssues(pi, ctx, version, snapshot);
            return;
        }
        const session = currentSession(ctx, snapshot);
        const drafts = new Map<string, SliceDraft>();
        const saved = new Set<string>();
        while (true) {
            const remaining = candidates.filter((candidate) => !saved.has(candidate.entryId));
            if (!remaining.length) break;
            const suggested = remaining.filter((candidate) => candidate.signals.length);
            ctx.ui.setStatus("casepick", `CasePick：${suggested.length} 个候选，已保存 ${saved.size} 条`);
            const mode = await ctx.ui.select(`已读取当前分支 ${snapshot.messages.length} 条消息。\n选择一条出错回复，原要求必须在它之前出现。`, [
                ...(suggested.length ? [`审阅疑似犯错（${suggested.length} 条）`] : []),
                `手动选择历史回复（${remaining.length} 条）`, "整理长程问题（跨多轮、多个会话）", "结束",
            ]);
            if (!mode || mode === "结束") break;
            if (mode.startsWith("整理长程问题")) {
                await manageIssues(pi, ctx, version, snapshot);
                continue;
            }
            const list = mode.startsWith("审阅") ? suggested : remaining;
            const candidate = await pick(ctx.ui, "选择原出错回复（最近的在前）", [...list].reverse(),
                (item) => `消息 #${item.messageIndex + 1} ${item.signals.length ? `[${item.signals.join("、")}] ` : ""}${item.preview}`);
            if (!candidate) continue;
            let draft = drafts.get(candidate.entryId);
            if (!draft) {
                try {
                    draft = buildSlice(ctx, session, candidate.entryId, version);
                    drafts.set(candidate.entryId, draft);
                } catch (error) {
                    ctx.ui.notify(`无法整理这条回复：${error instanceof Error ? error.message : String(error)}`, "error");
                    continue;
                }
            }
            if (await reviewCase(ctx.ui, draft.doc, draft.context, path, (doc) => appendCase(doc, path), draft.options)) saved.add(candidate.entryId);
        }
        ctx.ui.notify(saved.size ? `本次已生成并保存 ${saved.size} 条案例：\n${path}` : "本次未保存案例。", "info");
    } finally {
        ctx.ui.setStatus("casepick", undefined);
    }
}
