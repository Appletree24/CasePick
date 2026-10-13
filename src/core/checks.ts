import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, Check } from "../schema/case.ts";

export interface CheckResult {
    verdict: "pass" | "fail" | "unknown";
    reason: string;
}

function result(passed: boolean, reason: string): CheckResult {
    return { verdict: passed ? "pass" : "fail", reason };
}

function unknown(reason: string): CheckResult {
    return { verdict: "unknown", reason };
}

// 对象递归匹配自有属性子集；数组为完整值，不做前缀或无序匹配。
function subset(actual: unknown, expected: unknown): boolean {
    if (expected === null || typeof expected !== "object" || Array.isArray(expected)) {
        return isDeepStrictEqual(actual, expected);
    }
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const record = actual as Record<string, unknown>;
    return Object.entries(expected).every(([key, value]) =>
        Object.hasOwn(record, key) && subset(record[key], value));
}

function checkTool(check: Extract<Check, { name: string }>, observed: AssistantMessage): CheckResult {
    let unreadable = false;
    for (const call of observed.tool_calls ?? []) {
        if (call.function.name !== check.name) continue;
        if (check.args_match !== undefined) {
            let args: unknown;
            try {
                args = JSON.parse(call.function.arguments);
            } catch {
                unreadable = true;
                continue;
            }
            if (args === null || typeof args !== "object" || Array.isArray(args)) {
                unreadable = true;
                continue;
            }
            if (!subset(args, check.args_match)) continue;
        }
        return result(check.type === "tool_called", `找到匹配的工具调用：${check.name}（${call.id}）`);
    }
    if (unreadable) return unknown(`工具 ${check.name} 的参数不是合法 JSON 对象，无法排除匹配`);
    return result(check.type === "tool_not_called", `未找到匹配的工具调用：${check.name}`);
}

// 只检查 next_message 的一条录制回复，不执行工具，也不判整条 requirement。
// 输入沿用 schema 的类型；JSON 导入的结构校验由调用方负责。
export function evaluateCheck(check: Check, observed: AssistantMessage): CheckResult {
    if ("name" in check) {
        return checkTool(check, observed);
    }
    if (check.scope === "tool_calls") {
        return unknown("Detroit 尚未规定文字检查的 tool_calls 序列化规则");
    }
    // 单条 next_message 的 final_text 与 all_text 都是 content，不包含工具参数。
    const text = observed.content ?? "";
    switch (check.type) {
        case "json_only":
            try {
                JSON.parse(text);
                return result(true, "输出整体是合法 JSON");
            } catch {
                return result(false, "输出整体不是合法 JSON");
            }
        case "contains":
        case "not_contains": {
            const found = check.ignore_case
                ? text.toLowerCase().includes(check.text.toLowerCase())
                : text.includes(check.text);
            return result(check.type === "contains" ? found : !found,
                `${found ? "找到" : "未找到"}指定文字：${check.text}`);
        }
        case "regex":
        case "not_regex": {
            let regex: RegExp;
            try {
                if (!/^[imsu]*$/.test(check.flags ?? "")) return unknown("正则 flags 只允许 i、m、s、u");
                regex = new RegExp(check.pattern, check.flags);
            } catch {
                return unknown("正则表达式或 flags 无效");
            }
            const found = regex.test(text);
            return result(check.type === "regex" ? found : !found,
                `${found ? "匹配" : "不匹配"}正则：${check.pattern}`);
        }
    }
}
