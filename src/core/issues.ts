// 长程任务的主案例与证据时间线（docs/long-trajectory-slicing.md §3、§6）。
// 主案例只在本地使用，不导出；对外只有切片生成的普通案例。

import { randomUUID } from "node:crypto";
import { type Static, type TSchema, Type } from "@sinclair/typebox/type";
import type { CaseDocument } from "../schema/case.ts";

const closed = { additionalProperties: false } as const;
const Strict = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, closed);
const NonEmpty = Type.String({ minLength: 1 });

export const EvidenceKind = Type.Union([
    Type.Literal("tool_output"), Type.Literal("user_statement"), Type.Literal("assistant_claim"),
    Type.Literal("user_correction"), Type.Literal("postmortem"),
]);

export const Evidence = Strict({
    id: NonEmpty,
    session: NonEmpty,               // 会话 ID 的哈希，与案例的 session key 一致
    entry: NonEmpty,                 // 原会话 entry ID
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("tool")]),
    kind: EvidenceKind,
    at: Type.String(),               // 原始时间；拿不到时为空字符串
    excerpt: NonEmpty,               // 原文片段，逐字
    content_hash: NonEmpty,          // 整条原消息的摘要
    availability: Type.Union([Type.Literal("original"), Type.Literal("excerpt_only")]),
    note: Type.Optional(Type.String()),
});

export const IssueSession = Strict({
    key: NonEmpty,
    file: Type.Optional(NonEmpty),   // 本机路径，只用于再次打开，不导出
    label: Type.String(),
});

export const IssueSlice = Strict({
    case_id: NonEmpty,
    session: NonEmpty,
    cutoff_entry: NonEmpty,
    keys: Type.Array(Type.String()),
});

export const Issue = Strict({
    id: Type.String({ pattern: "^issue_[A-Za-z0-9-]+$" }),
    revision: Type.Integer({ minimum: 1 }),
    title: NonEmpty,
    status: Type.Union([Type.Literal("open"), Type.Literal("resolved")]),
    sessions: Type.Array(IssueSession),
    evidence: Type.Array(Evidence),
    resolution: Type.Optional(Strict({
        statement: NonEmpty,
        evidence: Type.Optional(NonEmpty),
        confidence: Type.Union([Type.Literal("user_reported"), Type.Literal("reproduced")]),
        unknowns: Type.Array(NonEmpty),
    })),
    slices: Type.Array(IssueSlice),
    created_at: Type.String(),
    updated_at: Type.String(),
    deleted: Type.Optional(Type.Boolean()),
});

export type Evidence = Static<typeof Evidence>;
export type EvidenceKind = Static<typeof EvidenceKind>;
export type Issue = Static<typeof Issue>;
export type IssueSlice = Static<typeof IssueSlice>;

export const evidenceKindLabels: Record<EvidenceKind, string> = {
    tool_output: "工具输出",
    user_statement: "用户陈述",
    assistant_claim: "助手结论",
    user_correction: "用户纠正",
    postmortem: "事后复盘",
};

export function newIssue(title: string, now = new Date().toISOString()): Issue {
    return { id: `issue_${randomUUID()}`, revision: 1, title, status: "open", sessions: [], evidence: [], slices: [], created_at: now, updated_at: now };
}

export function addSession(issue: Issue, session: Issue["sessions"][number]): boolean {
    const existing = issue.sessions.find((item) => item.key === session.key);
    if (existing) {
        if (session.file && !existing.file) existing.file = session.file;
        return false;
    }
    issue.sessions.push(session);
    return true;
}

// 同一会话、同一 entry、同一段摘录只记一次。
export function addEvidence(issue: Issue, evidence: Omit<Evidence, "id">): Evidence | undefined {
    if (issue.evidence.some((item) => item.session === evidence.session && item.entry === evidence.entry && item.excerpt === evidence.excerpt)) return undefined;
    const added = { id: `ev_${issue.evidence.length + 1}_${randomUUID().slice(0, 8)}`, ...evidence };
    issue.evidence.push(added);
    return added;
}

// 按原始时间排序；时间缺失或相同时保持录入顺序。
export function timeline(issue: Issue): Evidence[] {
    return issue.evidence.map((item, index) => ({ item, index }))
        .sort((a, b) => (a.item.at && b.item.at && a.item.at !== b.item.at ? (a.item.at < b.item.at ? -1 : 1) : a.index - b.index))
        .map(({ item }) => item);
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

// 去重键：依据类型 + 规范编号 + 推翻它的证据原文（docs §6）。
export function sliceKeys(doc: Pick<CaseDocument, "scoring" | "extensions">): string[] {
    const bases = doc.extensions?.["x-casepick"]?.requirements ?? {};
    return doc.scoring.requirements.map((requirement) => {
        const basis = bases[requirement.id] ?? { basis: "instruction" as const };
        const norm = basis.basis === "norm" ? basis.norm : "-";
        return `${basis.basis}|${norm}|${normalize(requirement.source.quote)}`;
    });
}

export function duplicateSlices(issue: Issue, keys: readonly string[], exceptCase?: string): IssueSlice[] {
    return issue.slices.filter((slice) => slice.case_id !== exceptCase && slice.keys.some((key) => keys.includes(key)));
}

export function recordSlice(issue: Issue, slice: IssueSlice): void {
    issue.slices = [...issue.slices.filter((item) => item.case_id !== slice.case_id), slice];
}

// 截止点之后才出现的内容：同一主案例里时间更晚的证据，以及最终结论。
// 用于防后见之明检查；截止点时间缺失时，不在同一会话的证据都视为可能更晚。
export function laterTexts(issue: Issue, cutoff: { session: string; entry: string; at: string }): string[] {
    const ordered = timeline(issue);
    const position = ordered.findIndex((item) => item.session === cutoff.session && item.entry === cutoff.entry);
    const later = ordered.filter((item, index) => {
        if (position >= 0) return index > position;
        if (cutoff.at && item.at) return item.at > cutoff.at;
        return item.session !== cutoff.session;
    });
    return [
        ...later.map((item) => item.excerpt),
        ...(issue.resolution ? [issue.resolution.statement, ...issue.resolution.unknowns] : []),
    ];
}

export function mergeIssues(target: Issue, source: Issue): void {
    for (const session of source.sessions) addSession(target, session);
    for (const evidence of source.evidence) {
        if (!target.evidence.some((item) => item.session === evidence.session && item.entry === evidence.entry && item.excerpt === evidence.excerpt)) {
            target.evidence.push(evidence);
        }
    }
    for (const slice of source.slices) recordSlice(target, slice);
    target.resolution ??= source.resolution;
}

// 把选中的证据拆成一个新的主案例；切片留在原主案例，由用户决定是否重新整理。
export function splitIssue(issue: Issue, evidenceIds: readonly string[], title: string): Issue {
    const moved = issue.evidence.filter((item) => evidenceIds.includes(item.id));
    const created = newIssue(title);
    created.evidence = moved;
    created.sessions = issue.sessions.filter((session) => moved.some((item) => item.session === session.key));
    issue.evidence = issue.evidence.filter((item) => !evidenceIds.includes(item.id));
    return created;
}
