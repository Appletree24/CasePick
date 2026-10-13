import type { AssistantMessage, Message, Requirement } from "../schema/case.ts";
import { evaluateCheck } from "./checks.ts";
import type { RecordedEntry } from "./messages.ts";
import { rubricForCheck } from "./rubric.ts";

export interface Candidate {
    entryId: string;
    messageIndex: number;
    signals: string[];
    preview: string;
}

export function messagePreview(message: Message, limit = 90): string {
    const text = message.content || (message.role === "assistant"
        ? (message.tool_calls ?? []).map((call) => `调用 ${call.function.name}`).join("、") : "");
    const characters = Array.from(text.replace(/\s+/g, " "));
    return characters.slice(0, limit).join("") + (characters.length > limit ? "…" : "");
}

// 只用最近一条用户消息做保守预填；是否仍然适用由用户在审阅时确认。
// 草稿用截止点当时的实际上下文再次计算，不能沿用扫描阶段的原始历史下标。
export function ruleRequirements(messages: readonly Message[], observed: AssistantMessage): Requirement[] {
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role !== "user") index--;
    if (index < 0) return [];
    const text = messages[index].content ?? "";
    const rules = [
        { pattern: /只(?:能)?(?:输出|返回)\s*JSON(?:\s*(?:格式|数据))?|(?:output|return)\s+(?:only\s+JSON|JSON\s+only)/i, check: { type: "json_only" } as const },
        { pattern: /(?:不要|禁止|别)(?:使用|输出|加|用)?\s*(?:Markdown\s*)?代码块|no\s+(?:markdown\s+)?code\s+(?:blocks?|fences?)/i,
            check: { type: "not_regex", pattern: "(^|\\n)[ \\t]*(?:`{3,}|~{3,})" } as const },
    ];
    const requirements: Requirement[] = [];
    for (const rule of rules) {
        const quote = rule.pattern.exec(text)?.[0];
        if (!quote || evaluateCheck(rule.check, observed).verdict !== "fail") continue;
        requirements.push({
            id: `r${requirements.length + 1}`, text: quote, required: true,
            source: { message: index, quote }, checks: [{ ...rule.check }], rubric: rubricForCheck(rule.check, observed),
        });
    }
    return requirements;
}

// 信号只用于排序和定位，不替用户认定错误。没有信号的回复仍可手动选取。
export function findCandidates(entries: readonly RecordedEntry[]): Candidate[] {
    const candidates: Candidate[] = [];
    let lastUser: Message | undefined;
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (entry.message.role === "user") lastUser = entry.message;
        if (entry.message.role !== "assistant") continue;
        const signals: string[] = [];
        if (lastUser && ruleRequirements([lastUser], entry.message).length) signals.push("格式冲突");
        if (entry.interrupted) signals.push("用户中断或回复异常");
        let next = index + 1;
        let toolError = false;
        while (entries[next]?.message.role === "tool") {
            toolError ||= entries[next].toolError === true;
            next++;
        }
        const reply = entries[next]?.message;
        if (reply?.role === "user") {
            if (/(不对|不是|我说过|我说了|别|不要|重来|撤销|\b(?:no|wrong|I said|revert)\b)/i.test(reply.content)) signals.push("用户纠正");
            if (toolError) signals.push("工具报错后用户介入");
        }
        candidates.push({ entryId: entry.id, messageIndex: index, signals, preview: messagePreview(entry.message) });
    }
    return candidates;
}
