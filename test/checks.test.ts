import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCheck } from "../src/core/checks.ts";
import type { AssistantMessage, Check } from "../src/schema/case.ts";

function verdict(check: Check, content: string) {
    return evaluateCheck(check, { role: "assistant", content }).verdict;
}

function tools(...args: string[]): AssistantMessage {
    return {
        role: "assistant", content: null,
        tool_calls: args.map((arguments_, i) => ({
            id: `call-${i}`, type: "function", function: { name: "edit", arguments: arguments_ },
        })),
    };
}

test("JSON 检查整个输出，接受所有 JSON 值而非仅对象", () => {
    for (const text of [' {}\n', '[]', 'null', 'true', '42', '"ok"']) {
        assert.equal(verdict({ type: "json_only" }, text), "pass");
    }
    for (const text of ['', '解释 {}', '```json\n{}\n```', '{} {}', '{"x":NaN}']) {
        assert.equal(verdict({ type: "json_only" }, text), "fail");
    }
});

test("正反文字约束和大小写开关", () => {
    assert.equal(verdict({ type: "contains", text: "hello" }, "Hello"), "fail");
    assert.equal(verdict({ type: "contains", text: "hello", ignore_case: true }, "Hello"), "pass");
    assert.equal(verdict({ type: "not_contains", text: "hello", ignore_case: true }, "Hello"), "fail");
    assert.equal(verdict({ type: "not_contains", text: "禁止" }, "允许"), "pass");
});

test("正反正则支持 flags，非法正则不可判定而非通过", () => {
    assert.equal(verdict({ type: "regex", pattern: "^hello$", flags: "im" }, "first\nHELLO"), "pass");
    assert.equal(verdict({ type: "not_regex", pattern: "a.b", flags: "s" }, "a\nb"), "fail");
    assert.equal(verdict({ type: "regex", pattern: "^.$", flags: "u" }, "😀"), "pass");
    for (const type of ["regex", "not_regex"] as const) {
        assert.equal(verdict({ type, pattern: "[" }, "anything"), "unknown");
        assert.equal(verdict({ type, pattern: "x", flags: "ii" }, "x"), "unknown");
        assert.equal(verdict({ type, pattern: "x", flags: "g" }, "x"), "unknown");
        assert.equal(verdict({ type, pattern: "x" }, "y"), type === "regex" ? "fail" : "pass");
    }
});

test("单条回复文字 scope 不混入工具参数，未定义的序列化不猜测", () => {
    const observed = tools('{"text":"secret"}');
    for (const scope of ["final_text", "all_text"] as const) {
        assert.equal(evaluateCheck({ type: "contains", text: "secret", scope }, observed).verdict, "fail");
    }
    assert.equal(evaluateCheck({ type: "json_only" }, observed).verdict, "fail");
    assert.equal(evaluateCheck({ type: "json_only", scope: "tool_calls" }, observed).verdict, "unknown");
});

test("工具名称匹配不需要可解析参数，空调用列表可确定判定", () => {
    assert.equal(evaluateCheck({ type: "tool_called", name: "edit" }, tools("broken")).verdict, "pass");
    assert.equal(evaluateCheck({ type: "tool_not_called", name: "edit" }, tools("broken")).verdict, "fail");
    assert.equal(evaluateCheck({ type: "tool_called", name: "read" }, tools("broken")).verdict, "fail");
    assert.equal(verdict({ type: "tool_not_called", name: "edit" }, "edit()"), "pass");
});

test("工具参数递归对象子集；数组保持长度、顺序和值；不读取原型", () => {
    const observed = tools('{"options":{"path":"src/a.ts","extra":true},"list":[1,2],"nil":null}');
    for (const [args_match, expected] of [
        [{ options: { path: "src/a.ts" } }, "pass"],
        [{ options: { path: "test/a.ts" } }, "fail"],
        [{ list: [1, 2] }, "pass"],
        [{ list: [1] }, "fail"],
        [{ list: [2, 1] }, "fail"],
        [{ nil: null }, "pass"],
        [{ missing: null }, "fail"],
        [{ toString: {} }, "fail"],
    ] as const) {
        assert.equal(evaluateCheck({ type: "tool_called", name: "edit", args_match }, observed).verdict, expected);
    }
});

test("无效参数传播 unknown，但任意确定匹配优先于不可判定", () => {
    for (const type of ["tool_called", "tool_not_called"] as const) {
        const check: Check = { type, name: "edit", args_match: { path: "a" } };
        for (const broken of ["{", "null", "[]", "42"]) {
            assert.equal(evaluateCheck(check, tools(broken, '{"path":"b"}')).verdict, "unknown");
            assert.equal(evaluateCheck(check, tools(broken, '{"path":"a"}')).verdict,
                type === "tool_called" ? "pass" : "fail");
        }
    }
});
