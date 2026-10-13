import { isDeepStrictEqual } from "node:util";
import { Type } from "@sinclair/typebox/type";
import {
    CaseDocument as CaseSchema,
    schemaErrors,
    type AssistantMessage,
    type CaseDocument,
    type Message,
    type Rubric,
} from "../schema/case.ts";
import { evaluateCheck, type CheckResult } from "./checks.ts";
import { canonicalize, scoringDigest, taskDigest } from "./digest.ts";
import { observedTexts, rubricErrors } from "./rubric.ts";

export interface LintIssue {
    severity: "error" | "warning";
    code: string;
    path: string;
    message: string;
}

export interface LintCheckResult extends CheckResult {
    requirementId: string;
    path: string;
    // 只有对原出错输出判 fail 的约束才有效；pass 和 unknown 都需要编辑者处理。
    usable: boolean;
}

export interface LintOptions {
    stage?: "draft" | "confirm" | "export";
    followupMinLength?: number;
    // 从当前分支独立取得的快照，包含截止点消息本身。
    // 消息已经过格式转换、压缩上下文选择和与案例一致的脱敏，不能从待检查案例反向构造。
    source?: {
        entries: readonly { id: string; message: Message }[];
        cutoffEntry: string;
    };
    // 脱敏前的对应输入和出错输出，用于核对引用片段没有被替换。消息顺序与脱敏后相同。
    beforeRedaction?: {
        messages: readonly Message[];
        observed: AssistantMessage;
    };
}

export interface LintResult {
    // 仅表示本阶段没有 error；警告仍需审阅，不能代替确认流程。
    valid: boolean;
    issues: LintIssue[];
    checks: LintCheckResult[];
    reviewMode: "program" | "rubric";
    cutoffVerified: boolean;
}

type CaseDraft = Pick<CaseDocument, "task" | "scoring" | "diagnostic"> & Partial<CaseDocument>;
// 本文要读取的来源和扩展字段，草稿里可以缺失，但提供时也要校验其结构。
// 其余信封字段在草稿阶段允许未完成，到确认 / 导出时才检查。
const DraftBody = Type.Object({
    ...Type.Pick(CaseSchema, ["task", "scoring", "diagnostic"]).properties,
    ...Type.Partial(Type.Pick(CaseSchema, ["provenance", "extensions"])).properties,
});
type AddIssue = (severity: LintIssue["severity"], code: string, path: string, message: string) => void;

function checkToolMessages(messages: readonly Message[], add: AddIssue): void {
    const seen = new Set<string>();
    const pending = new Map<string, string>();
    const reportPending = () => {
        for (const [id, path] of pending) add("error", "tool_result_missing", path, `工具调用 ${id} 缺少紧随其后的工具结果`);
        pending.clear();
    };
    messages.forEach((message, index) => {
        const path = `/task/messages/${index}`;
        if (message.role === "tool") {
            if (!pending.delete(message.tool_call_id)) {
                add("error", "tool_result_unmatched", `${path}/tool_call_id`, "工具结果没有对应的待完成调用，或同一调用已有结果");
            }
            return;
        }
        // 并行调用可以以任意顺序返回，但中间不能插入 user / assistant 消息。
        reportPending();
        if (message.role !== "assistant") return;
        (message.tool_calls ?? []).forEach((call, callIndex) => {
            const callPath = `${path}/tool_calls/${callIndex}`;
            if (seen.has(call.id)) add("error", "tool_call_id_duplicate", `${callPath}/id`, `工具调用 ID 重复：${call.id}`);
            seen.add(call.id);
            pending.set(call.id, callPath);
        });
    });
    reportPending();
}

function checkSource(doc: CaseDraft, options: LintOptions, add: AddIssue): boolean {
    if (!options.source) {
        add(options.stage === "confirm" ? "error" : "warning", "cutoff_unverified", "/task/messages",
            "没有原会话快照，无法核对截止点、消息顺序和原文；确认前必须提供 source");
        return false;
    }
    const { entries, cutoffEntry } = options.source;
    const positions = entries.flatMap((entry, index) => entry.id === cutoffEntry ? [index] : []);
    if (positions.length !== 1) {
        add("error", "cutoff_invalid", "/task/messages", "截止点必须在原会话快照中出现且只出现一次");
        return false;
    }
    let verified = true;
    const cutoff = positions[0];
    if (!isDeepStrictEqual(doc.task.messages, entries.slice(0, cutoff).map((entry) => entry.message))) {
        add("error", "input_source_mismatch", "/task/messages", "输入必须与截止点之前的消息原文和顺序一致，不能包含出错消息或后续内容");
        verified = false;
    }
    if (!isDeepStrictEqual(doc.diagnostic.observed, entries[cutoff].message)) {
        add("error", "observed_source_mismatch", "/diagnostic/observed", "出错输出与截止点的原消息不一致");
        verified = false;
    }
    const savedCutoff = doc.extensions?.["x-casepick"]?.cutoff_entry;
    if (savedCutoff !== undefined && savedCutoff !== cutoffEntry) {
        add("error", "cutoff_entry_mismatch", "/extensions/x-casepick/cutoff_entry", "保存的截止点与原会话快照的截止点不一致");
        verified = false;
    }
    return verified;
}

function rubricFields(rubric: Rubric): [string, string][] {
    return [
        ["question", rubric.question], ["pass", rubric.pass], ["fail", rubric.fail],
        ...(rubric.edge_cases ?? []).map((text, index): [string, string] => [`edge_cases/${index}`, text]),
        ...rubric.examples.flatMap((example, index): [string, string][] => [
            [`examples/${index}/text`, example.text],
            ...(example.note === undefined ? [] : [[`examples/${index}/note`, example.note] as [string, string]]),
        ]),
    ];
}

function sharedFragment(text: string, sources: readonly string[], minimum: number): string | undefined {
    const characters = Array.from(text);
    for (let i = 0; i + minimum <= characters.length; i++) {
        const fragment = characters.slice(i, i + minimum).join("");
        if (fragment.trim() && sources.some((source) => source.includes(fragment))) return fragment;
    }
    return undefined;
}

function checkRequest(doc: CaseDraft, add: AddIssue): void {
    const { system, tools, messages } = doc.task;
    if ((system.status === "missing" && system.content !== null)
        || (system.status !== "missing" && system.content === null)) {
        add("error", "system_content_mismatch", "/task/system/content", "missing 的系统提示应为 null；captured / approximate 应提供文字");
    }
    if (tools.source === "none" && (tools.definitions?.length ?? 0) > 0) {
        add("error", "tools_source_mismatch", "/task/tools", "source 为 none 时不能同时提供工具定义");
    }
    if (tools.source !== "none" && tools.definitions === undefined) {
        add("error", "tool_definitions_missing", "/task/tools/definitions", "captured / approximate 的工具需要提供定义列表");
    }
    const names = new Set<string>();
    (tools.definitions ?? []).forEach((tool, index) => {
        if (names.has(tool.function.name)) add("error", "tool_name_duplicate", `/task/tools/definitions/${index}/function/name`, "工具定义名称重复");
        names.add(tool.function.name);
    });
    try {
        canonicalize({
            messages: [...(system.content === null ? [] : [{ role: "system", content: system.content }]), ...messages],
            ...(tools.definitions?.length ? { tools: tools.definitions } : {}),
        });
    } catch (error) {
        add("error", "request_not_serializable", "/task", `输入无法序列化为 JSON 请求体：${error instanceof Error ? error.message : String(error)}`);
    }
    checkToolMessages(messages, add);
}

// 纯本地诊断：不修改输入、清空字段、重算保存摘要或调用模型。
// draft 只检查正文；confirm / export 再检查完整 CasePick schema（Detroit 的严格子集）和摘要。
// 独立导出不依赖原会话文件；未提供 source 时显式报告 cutoffVerified: false。
export function lintCase(value: unknown, options: LintOptions = {}): LintResult {
    const issues: LintIssue[] = [];
    const checks: LintCheckResult[] = [];
    let cutoffVerified = false;
    const add: AddIssue = (severity, code, path, message) => issues.push({ severity, code, path, message });
    const finish = (): LintResult => ({
        valid: !issues.some((issue) => issue.severity === "error"),
        issues,
        checks,
        reviewMode: checks.some((check) => check.usable) ? "program" : "rubric",
        cutoffVerified,
    });
    const stage = options.stage ?? "draft";
    const minimum = options.followupMinLength ?? 12;
    if (!Number.isInteger(minimum) || minimum < 1) throw new RangeError("followupMinLength 必须是正整数");

    // 草稿允许缺少尚未生成的 ID、来源信封和摘要；正文必须能安全读取。
    const errors = schemaErrors(stage === "draft" ? DraftBody : CaseSchema, value);
    for (const error of errors) add("error", "schema_invalid", error.path, error.message);
    if (errors.length > 0) return finish();
    const doc = value as CaseDraft;
    checkRequest(doc, add);
    cutoffVerified = checkSource(doc, options, add);

    const observed = observedTexts(doc.diagnostic.observed);
    const originalObserved = options.beforeRedaction ? observedTexts(options.beforeRedaction.observed) : undefined;
    const followup = (doc.diagnostic.followup ?? []).flatMap((message) =>
        message.role === "assistant" ? observedTexts(message) : [message.content]);
    if (doc.provenance?.transforms?.some((transform) => transform.type === "redact") && !options.beforeRedaction) {
        add(stage === "confirm" ? "error" : "warning", "redaction_unverified", "/provenance/transforms",
            "没有脱敏前快照，无法核对脱敏是否改动引文或 observed 例子；确认前必须提供 beforeRedaction");
    }

    const ids = new Set<string>();
    doc.scoring.requirements.forEach((requirement, index) => {
        const path = `/scoring/requirements/${index}`;
        if (ids.has(requirement.id)) add("error", "requirement_id_duplicate", `${path}/id`, `要求 ID 重复：${requirement.id}`);
        ids.add(requirement.id);
        if (!requirement.text.trim()) add("error", "requirement_empty", `${path}/text`, "原要求不能只含空白");
        const { message, quote } = requirement.source;
        const source = doc.task.messages[message];
        if (!source) {
            add("error", "source_out_of_range", `${path}/source/message`, "引用必须指向截止点之前的 task.messages，不能引用原出错输出或后来才提出的要求");
        } else if (!quote.trim() || !source.content?.includes(quote)) {
            add("error", "source_quote_missing", `${path}/source/quote`, "引文不是所引用消息 content 的非空原文片段");
        }
        if (options.beforeRedaction && !options.beforeRedaction.messages[message]?.content?.includes(quote)) {
            add("error", "source_quote_redacted", `${path}/source/quote`, "引文在脱敏前的对应消息中不存在，可能被脱敏替换；请处理后再确认");
        }

        const rubricPath = `${path}/rubric`;
        for (const error of rubricErrors(requirement.rubric)) {
            add("error", "rubric_invalid", `${rubricPath}${error.path === "/" ? "" : error.path}`, error.message);
        }
        requirement.rubric.examples.forEach((example, exampleIndex) => {
            if (example.origin !== "observed") return;
            const examplePath = `${rubricPath}/examples/${exampleIndex}/text`;
            if (!observed.some((text) => text.includes(example.text))) {
                add("error", "observed_example_missing", examplePath, "例子不在原出错输出的 content 或某次工具调用的参数原文中，需要清空后重新填写");
            }
            if (originalObserved && !originalObserved.some((text) => text.includes(example.text))) {
                add("error", "observed_example_redacted", examplePath, "例子在脱敏前的原出错输出中不存在，可能被脱敏替换；请处理后再确认");
            }
        });
        for (const [field, text] of rubricFields(requirement.rubric)) {
            const limit = field === "question" ? 200 : 500;
            if (Array.from(text).length > limit) add("warning", "rubric_too_long", `${rubricPath}/${field}`, `建议不超过 ${limit} 个字符，评审标准过长容易判不稳`);
            const fragment = sharedFragment(text, followup, minimum);
            if (fragment !== undefined) add("warning", "rubric_followup_overlap", `${rubricPath}/${field}`, `与截止点之后的内容存在至少 ${minimum} 个连续字符重合：${JSON.stringify(fragment)}；请确认没有引入后来的要求`);
        }
        (requirement.checks ?? []).forEach((check, checkIndex) => {
            const checkPath = `${path}/checks/${checkIndex}`;
            const result = evaluateCheck(check, doc.diagnostic.observed);
            checks.push({ requirementId: requirement.id, path: checkPath, ...result, usable: result.verdict === "fail" });
            if (result.verdict !== "fail") add("warning", "check_ineffective", checkPath,
                `约束对原出错输出判为 ${result.verdict}，不能证明这次违反：${result.reason}`);
        });
    });
    const violated = new Set<string>();
    doc.diagnostic.violates.forEach((id, index) => {
        if (!ids.has(id)) add("error", "violation_unknown", `/diagnostic/violates/${index}`, `没有对应的原要求：${id}`);
        if (violated.has(id)) add("error", "violation_duplicate", `/diagnostic/violates/${index}`, `重复列出被违反的要求：${id}`);
        violated.add(id);
    });

    if (stage !== "draft") {
        for (const key of ["task", "scoring"] as const) {
            try {
                const expected = key === "task" ? taskDigest(doc.task) : scoringDigest(doc.scoring);
                if (doc.digests?.[key] !== expected) add("error", "digest_mismatch", `/digests/${key}`, "摘要与当前内容不一致，需要重新计算");
            } catch (error) {
                add("error", "digest_invalid", `/digests/${key}`, error instanceof Error ? error.message : String(error));
            }
        }
    }
    return finish();
}
