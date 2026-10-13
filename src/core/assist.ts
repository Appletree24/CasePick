// 模型辅助：找证据、提议切片（docs/long-trajectory-slicing.md §8）。
// 模型只返回编号和原文片段；这里逐条核对，核对不过的建议直接丢弃并给出原因，不重试。

import { type Static, Type } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import type { Message, Requirement, RequirementBasis, Rubric } from "../schema/case.ts";
import { evidenceKindLabels, type EvidenceKind } from "./issues.ts";
import { findNorm, norms, normsVersion, rubricForNorm } from "./norms.ts";
import { emptyRubric } from "./rubric.ts";

// 一条供模型阅读的会话消息。ref 在一次请求内唯一，如 "S1:E12"。
export interface AssistEntry {
    ref: string;
    session: string;
    entry: string;
    role: Message["role"];
    at: string;
    message: Message;
}

const perEntryLimit = 4000;

// 用于核对引文的原文：文字和每次工具调用的参数原文分开，不重新拼接。
export function entryTexts(message: Message): string[] {
    if (message.role === "assistant") return [message.content ?? "", ...(message.tool_calls ?? []).map((call) => call.function.arguments)];
    return [message.content];
}

function renderEntry(entry: AssistEntry): string {
    const { message } = entry;
    let body = message.content ?? "";
    if (message.role === "assistant" && message.tool_calls?.length) {
        body += message.tool_calls.map((call) => `\n[调用 ${call.function.name}] ${call.function.arguments}`).join("");
    }
    const characters = Array.from(body);
    const shown = characters.length > perEntryLimit ? `${characters.slice(0, perEntryLimit).join("")}\n[后面 ${characters.length - perEntryLimit} 字符未发送，不能引用]` : body;
    return `[${entry.ref}] ${message.role}${entry.at ? ` ${entry.at}` : ""}\n${shown}`;
}

// 按字符预算顺序分段；单条超长的消息独占一段（已在 renderEntry 中截断）。
// overlap 让每段带上前一段末尾的若干条消息，便于引用截止点之前不久的证据。
export function chunkEntries(entries: readonly AssistEntry[], maxChars = 100_000, overlap = 0): AssistEntry[][] {
    const chunks: AssistEntry[][] = [];
    let current: AssistEntry[] = [];
    let size = 0;
    let fresh = 0;
    for (const entry of entries) {
        const length = renderEntry(entry).length;
        if (fresh && size + length > maxChars) {
            chunks.push(current);
            current = overlap ? current.slice(-overlap) : [];
            size = current.reduce((sum, item) => sum + renderEntry(item).length, 0);
            fresh = 0;
        }
        current.push(entry);
        size += length;
        fresh++;
    }
    if (fresh) chunks.push(current);
    return chunks;
}

const normTable = norms.map((norm) => `- ${norm.id}：${norm.title}。生效条件：${norm.trigger}。`).join("\n");

const commonRules = `规则：
- 只能引用下面给出的消息原文，引文必须逐字复制，不能改写、拼接或省略中间内容。
- 只返回 JSON，不要任何解释文字或代码块标记。
- 不确定时宁可少报，不要编造编号或引文。`;

export interface Prompt {
    system: string;
    user: string;
}

export function evidencePrompt(issueTitle: string, entries: readonly AssistEntry[]): Prompt {
    return {
        system: `你在帮助整理一个长程排障问题的证据时间线。问题：${issueTitle}
从给出的会话消息里找出和这个问题有关的证据，每条证据摘录一段原文，并标注性质：
${Object.entries(evidenceKindLabels).map(([kind, label]) => `- ${kind}：${label}`).join("\n")}
${commonRules}
返回格式：{"evidence":[{"ref":"消息编号","kind":"性质","excerpt":"逐字原文片段","reason":"一句话"}]}`,
        user: entries.map(renderEntry).join("\n\n"),
    };
}

export function slicePrompt(issueTitle: string, entries: readonly AssistEntry[], options: { cutoff?: string; knownFacts?: readonly string[] } = {}): Prompt {
    return {
        system: `你在帮助把一个长程排障问题切成评测题。问题：${issueTitle}
一道题 = 选一条 assistant 回复作为截止点（cutoff），判断它是否违反了截止点之前已经成立的依据。依据有三种：
- instruction：截止点之前用户或系统明确提出的要求；
- evidence：截止点之前已经出现、与这条回复相矛盾的事实（工具输出或用户陈述）；
- norm：下面规范表中的一条工作规范，且截止点之前有让它生效的证据。
规范表 casepick.norms/${normsVersion}：
${normTable}
${commonRules}
- source 必须是截止点之前的消息，quote 是其中的逐字片段；violation 是截止点回复中违反依据的逐字片段。
- 评审标准只能依据截止点之前的内容。不要使用截止点之后才出现的事实、纠正或最终结论，也不要要求模型猜出当时无从知道的原因。
- 工具或环境报错导致的失败、用户后来改了需求、截止点之前证据不足以判断的位置，都不要出题。
- 同一个错误重复出现时，只为最早的一次出题。${options.cutoff ? `\n- 只针对截止点 ${options.cutoff} 出题，可以给出多条要求。` : ""}
返回格式：{"slices":[{"cutoff":"消息编号","basis":"instruction|evidence|norm","norm":"N1-N4，仅 basis 为 norm 时","source":"消息编号","quote":"逐字原文","violation":"逐字原文","requirement":"一句话要求","rubric":{"question":"是/否问题，是表示通过","pass":"通过条件","fail":"违反条件","edge_cases":["…"]},"reason":"一句话"}]}`,
        user: entries.map(renderEntry).join("\n\n"),
    };
}

// 容忍代码块包裹和前后说明，只取第一个完整的 JSON 对象。
export function parseJsonObject(text: string): unknown {
    const start = text.indexOf("{");
    if (start < 0) throw new Error("回复中没有 JSON 对象");
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const character = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (character === "\\") escaped = true;
            else if (character === "\"") inString = false;
        } else if (character === "\"") inString = true;
        else if (character === "{") depth++;
        else if (character === "}" && --depth === 0) return JSON.parse(text.slice(start, index + 1));
    }
    throw new Error("回复中的 JSON 不完整");
}

const EvidenceReply = Type.Object({
    evidence: Type.Array(Type.Object({
        ref: Type.String(), kind: Type.String(), excerpt: Type.String(), reason: Type.Optional(Type.String()),
    })),
});

const SliceReply = Type.Object({
    slices: Type.Array(Type.Object({
        cutoff: Type.String(),
        basis: Type.String(),
        norm: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        source: Type.String(),
        quote: Type.String(),
        violation: Type.String(),
        requirement: Type.String(),
        rubric: Type.Optional(Type.Object({
            question: Type.Optional(Type.String()), pass: Type.Optional(Type.String()), fail: Type.Optional(Type.String()),
            edge_cases: Type.Optional(Type.Array(Type.String())),
        })),
        reason: Type.Optional(Type.String()),
    })),
});

export interface Rejected {
    item: unknown;
    reason: string;
}

export interface EvidenceProposal {
    entry: AssistEntry;
    kind: EvidenceKind;
    excerpt: string;
    reason: string;
}

export function verifyEvidence(reply: unknown, entries: readonly AssistEntry[]): { accepted: EvidenceProposal[]; rejected: Rejected[] } {
    if (!Value.Check(EvidenceReply, reply)) return { accepted: [], rejected: [{ item: reply, reason: "回复不符合约定格式" }] };
    const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
    const accepted: EvidenceProposal[] = [];
    const rejected: Rejected[] = [];
    for (const item of (reply as Static<typeof EvidenceReply>).evidence) {
        const entry = byRef.get(item.ref);
        if (!entry) { rejected.push({ item, reason: `不存在的消息编号 ${item.ref}` }); continue; }
        if (!(item.kind in evidenceKindLabels)) { rejected.push({ item, reason: `未知的证据性质 ${item.kind}` }); continue; }
        if (!item.excerpt.trim() || !entryTexts(entry.message).some((text) => text.includes(item.excerpt))) {
            rejected.push({ item, reason: `摘录不是 ${item.ref} 的逐字原文` });
            continue;
        }
        accepted.push({ entry, kind: item.kind as EvidenceKind, excerpt: item.excerpt, reason: item.reason ?? "" });
    }
    return { accepted, rejected };
}

export interface SliceProposal {
    cutoff: AssistEntry;
    basis: "instruction" | "evidence" | "norm";
    norm?: "N1" | "N2" | "N3" | "N4";
    source: AssistEntry;
    quote: string;
    violation: string;
    requirement: string;
    // 模型给的评审标准；字段缺失时由规范模板或人工补。
    rubric: Partial<Pick<Rubric, "question" | "pass" | "fail" | "edge_cases">>;
    reason: string;
}

// entries 必须是同一会话、同一分支上按顺序排列的消息。
export function verifySlices(reply: unknown, entries: readonly AssistEntry[], fixedCutoff?: string): { accepted: SliceProposal[]; rejected: Rejected[] } {
    if (!Value.Check(SliceReply, reply)) return { accepted: [], rejected: [{ item: reply, reason: "回复不符合约定格式" }] };
    const position = new Map(entries.map((entry, index) => [entry.ref, index]));
    const accepted: SliceProposal[] = [];
    const rejected: Rejected[] = [];
    for (const item of (reply as Static<typeof SliceReply>).slices) {
        const reject = (reason: string) => rejected.push({ item, reason });
        const cutoffIndex = position.get(item.cutoff);
        const sourceIndex = position.get(item.source);
        if (cutoffIndex === undefined) { reject(`不存在的截止点编号 ${item.cutoff}`); continue; }
        if (fixedCutoff && item.cutoff !== fixedCutoff) { reject(`只能针对截止点 ${fixedCutoff}`); continue; }
        const cutoff = entries[cutoffIndex];
        if (cutoff.message.role !== "assistant") { reject(`${item.cutoff} 不是 assistant 回复`); continue; }
        if (sourceIndex === undefined) { reject(`不存在的出处编号 ${item.source}`); continue; }
        if (sourceIndex >= cutoffIndex) { reject("出处不在截止点之前，属于后来才出现的信息"); continue; }
        const source = entries[sourceIndex];
        if (source.message.role === "assistant") { reject("出处不能是助手自己的回复，应引用用户陈述或工具输出"); continue; }
        if (!["instruction", "evidence", "norm"].includes(item.basis)) { reject(`未知的依据类型 ${item.basis}`); continue; }
        const basis = item.basis as SliceProposal["basis"];
        let norm: SliceProposal["norm"];
        if (basis === "norm") {
            const found = item.norm ? findNorm(item.norm) : undefined;
            if (!found) { reject(`规范表里没有 ${item.norm ?? "（未填写）"}`); continue; }
            norm = found.id;
        }
        if (!item.quote.trim() || !(source.message.content ?? "").includes(item.quote)) { reject(`引文不是 ${item.source} 的逐字原文`); continue; }
        if (!item.violation.trim() || !entryTexts(cutoff.message).some((text) => text.includes(item.violation))) {
            reject(`违反片段不是 ${item.cutoff} 的逐字原文`);
            continue;
        }
        if (!item.requirement.trim()) { reject("缺少要求描述"); continue; }
        const rubric: SliceProposal["rubric"] = {};
        for (const field of ["question", "pass", "fail"] as const) {
            const value = item.rubric?.[field]?.trim();
            if (value) rubric[field] = value;
        }
        const edges = item.rubric?.edge_cases?.map((text) => text.trim()).filter(Boolean);
        if (edges?.length) rubric.edge_cases = edges;
        accepted.push({ cutoff, basis, norm, source, quote: item.quote, violation: item.violation, requirement: item.requirement.trim(), rubric, reason: item.reason ?? "" });
    }
    return { accepted, rejected };
}

// 把核对过的提议转成案例要求。出处按重建后的截止点输入重新定位：
// 压缩等原因导致原文不在输入里时，返回错误，不能引用模型当时看不到的内容。
export function requirementFromProposal(proposal: SliceProposal, input: readonly Message[], id: string): {
    requirement: Requirement;
    basis: RequirementBasis;
} | { error: string } {
    let index = -1;
    for (let position = input.length - 1; position >= 0; position--) {
        const message = input[position];
        if (message.role === proposal.source.message.role && (message.content ?? "").includes(proposal.quote)) { index = position; break; }
    }
    if (index < 0) return { error: "引文不在截止点当时的输入里（可能已被压缩），不能作为出处" };
    const norm = proposal.norm ? findNorm(proposal.norm) : undefined;
    const template = norm ? rubricForNorm(norm) : emptyRubric();
    const rubric: Rubric = {
        ...template,
        question: proposal.rubric.question ?? template.question,
        pass: proposal.rubric.pass ?? template.pass,
        fail: proposal.rubric.fail ?? template.fail,
        edge_cases: proposal.rubric.edge_cases ?? template.edge_cases,
        examples: [{ verdict: "fail", origin: "observed", text: proposal.violation }],
    };
    const basis: RequirementBasis = proposal.basis === "norm" && norm ? { basis: "norm", norm: norm.id, norms_version: normsVersion }
        : proposal.basis === "evidence" ? { basis: "evidence" } : { basis: "instruction" };
    return { requirement: { id, text: proposal.requirement, required: true, source: { message: index, quote: proposal.quote }, rubric }, basis };
}
