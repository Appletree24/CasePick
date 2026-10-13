import { randomUUID } from "node:crypto";
import type { CaseDocument } from "../schema/case.ts";
import { ruleRequirements } from "./candidates.ts";
import { caseDigests } from "./digest.ts";
import type { CaseContext } from "./messages.ts";

export function refreshDraft(doc: CaseDocument): void {
    doc.diagnostic.violates = doc.scoring.requirements.map((requirement) => requirement.id);
    const checks = doc.scoring.requirements.flatMap((requirement) => requirement.checks ?? []);
    doc.task.output.format = checks.some((check) => check.type === "json_only") ? "json"
        : checks.some((check) => "name" in check) ? "tool_calls" : "text";
    doc.digests = caseDigests(doc);
}

// 返回可编辑草稿，可能没有要求；审阅流程必须通过 confirm lint 后才能保存。
export function draftCase(context: CaseContext, version: string): CaseDocument {
    const requirements = ruleRequirements(context.input.map((entry) => entry.message), context.observed);
    const producer = { name: "casepick", version, method: requirements.length ? "rule:format@1" : "manual" };
    const dependsOnEnvironment = context.input.some((entry) => entry.message.role === "tool") || Boolean(context.observed.tool_calls?.length);
    const doc: CaseDocument = {
        schema: "detroit.case/v2", id: `casepick:${randomUUID()}`, revision: 1,
        title: requirements[0] ? `未遵守要求：${requirements[0].text}` : "待填写案例标题",
        task: {
            kind: "agent", horizon: "next_message", start: "current",
            messages: context.input.map((entry) => structuredClone(entry.message)),
            system: structuredClone(context.system), tools: structuredClone(context.tools),
            environment: { kind: dependsOnEnvironment ? "unavailable" : "none" }, output: { format: "text" },
            ...(dependsOnEnvironment ? { limitations: [{ field: "task.environment", status: "unrecoverable", note: "涉及工具或文件状态，未保存当时运行环境；只评审下一条回复，不执行工具" }] } : {}),
        },
        scoring: { producer, combine: { rule: "required_then_threshold" }, requirements },
        diagnostic: { observed: structuredClone(context.observed), violates: [], followup: structuredClone(context.followup) },
        provenance: {
            source: { kind: "session", reference: `${context.sessionKey}#${context.cutoffEntry}`, group_key: context.sessionKey },
            purpose: "improvement", producer: { ...producer }, created_at: new Date().toISOString(),
            limitations: structuredClone(context.limitations), transforms: structuredClone(context.transforms),
        },
        extensions: { "x-casepick": { cutoff_entry: context.cutoffEntry, host_version: context.hostVersion, rubric_edited: false } },
        digests: { task: "", scoring: "" },
    };
    refreshDraft(doc);
    return doc;
}
