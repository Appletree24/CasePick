// 从某个会话的某个截止点生成切片草稿，长程主案例和单条回复两种入口共用。

import type { WorkflowContext } from "../host.ts";
import { entryTexts, requirementFromProposal, type SliceProposal } from "../core/assist.ts";
import { draftCase, nextRequirementId, setBasis } from "../core/draft-rule.ts";
import { duplicateSlices, laterTexts, sliceKeys, type Issue } from "../core/issues.ts";
import type { CaseContext } from "../core/messages.ts";
import type { CaseDocument } from "../schema/case.ts";
import { proposeSlices } from "./assist-run.ts";
import { contextAt } from "./read-session.ts";
import { assistEntries, entryTime, type LoadedSession } from "./sources.ts";
import type { ReviewOptions } from "./ui.ts";

export interface SliceDraft {
    context: CaseContext;
    doc: CaseDocument;
    options: ReviewOptions;
}

// 同一会话里截止点之后的全部内容，不只是紧跟着的纠正。
function laterInSession(session: LoadedSession, cutoffEntry: string): string[] {
    const position = session.snapshot.messages.findIndex((entry) => entry.id === cutoffEntry);
    return position < 0 ? [] : session.snapshot.messages.slice(position + 1).flatMap((entry) => entryTexts(entry.message));
}

// 把核对过的提议加进草稿；返回加入的条数和不能加入的原因。
export function applyProposals(doc: CaseDocument, context: CaseContext, proposals: readonly SliceProposal[], method: string): { added: number; errors: string[] } {
    let added = 0;
    const errors: string[] = [];
    for (const proposal of proposals) {
        const result = requirementFromProposal(proposal, context.input.map((entry) => entry.message), nextRequirementId(doc));
        if ("error" in result) { errors.push(`${proposal.requirement}：${result.error}`); continue; }
        doc.scoring.requirements.push(result.requirement);
        setBasis(doc, result.requirement.id, result.basis);
        added++;
    }
    if (added) {
        doc.provenance.producer.method = method;
        if (doc.scoring.producer) doc.scoring.producer.method = method;
        if (doc.title === "待填写案例标题") doc.title = proposals[0].requirement;
    }
    return { added, errors };
}

export function buildSlice(ctx: WorkflowContext, session: LoadedSession, cutoffEntry: string, version: string, issue?: Issue): SliceDraft {
    const context = contextAt(session.snapshot, cutoffEntry);
    if (session.external && context.tools.source === "approximate") {
        context.limitations.push({ field: "task.tools", status: "approximate", note: "截止点不在当前会话；工具定义取自本次扫描时的配置，可能与原会话不同" });
    }
    const doc = draftCase(context, version);
    const later = laterInSession(session, cutoffEntry);
    if (issue) {
        doc.provenance.source.group_key = issue.id;
        doc.extensions!["x-casepick"]!.issue_id = issue.id;
        later.push(...laterTexts(issue, { session: session.key, entry: cutoffEntry, at: entryTime(session.snapshot, cutoffEntry) }));
    }
    const options: ReviewOptions = {
        laterTexts: later,
        modelDraft: async (draft) => {
            // 发给模型的是截止点之前的消息加紧跟着的纠正，纠正只帮助理解错在哪里。
            const entries = assistEntries(session, "S1");
            const cutoff = entries.findIndex((entry) => entry.entry === cutoffEntry);
            if (cutoff < 0) throw new Error("截止点不在这个会话的主分支上");
            let end = cutoff + 1;
            while (end < entries.length && entries[end].role !== "assistant") end++;
            const proposals = await proposeSlices(ctx, issue?.title ?? draft.title, entries.slice(0, end), entries[cutoff].ref);
            if (!proposals?.length) return 0;
            const { added, errors } = applyProposals(draft, context, proposals, "model");
            if (errors.length) ctx.ui.notify(`有 ${errors.length} 条提议没有加入：\n${errors.join("\n")}`, "warning");
            return added;
        },
    };
    if (issue) {
        options.linkEvidence = (quote) => issue.evidence
            .filter((item) => item.session === session.key && (quote.includes(item.excerpt) || item.excerpt.includes(quote)))
            .map((item) => item.id);
        options.duplicates = (draft) => {
            const duplicates = duplicateSlices(issue, sliceKeys(draft), draft.id);
            return duplicates.length ? `和这个主案例里已确认的 ${duplicates.length} 道题依据相同：${duplicates.map((slice) => slice.case_id).join("、")}` : undefined;
        };
    }
    return { context, doc, options };
}
