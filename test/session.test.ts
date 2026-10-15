import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piSdk from "@earendil-works/pi-coding-agent";
import type { WorkflowContext } from "../src/host.ts";
import { Type as OmpType } from "@oh-my-pi/omptype/typebox";
import Ajv2020 from "ajv/dist/2020.js";
import { contextAt, readSession } from "../src/pi/read-session.ts";
import { convertMessage } from "../src/core/convert.ts";
import { draftCase } from "../src/core/draft-rule.ts";
import { lintCase } from "../src/core/lint.ts";
import { contextSource } from "../src/core/messages.ts";

function assistant(text: string) {
    return {
        role: "assistant" as const, content: [{ type: "text" as const, text }],
        api: "anthropic-messages" as const, provider: "anthropic", model: "fixture",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const, timestamp: 0,
    };
}

async function scan(manager: SessionManager) {
    return readSession({ sessionManager: manager, piSdk } as WorkflowContext, {
        getActiveTools: () => [], getAllTools: () => [],
    } as ExtensionAPI);
}

test("截止点之后的纠正和压缩不能改写原题，修正答案不进入 followup", async () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "只输出 JSON", timestamp: 0 });
    const cutoff = manager.appendMessage(assistant("好的，{}"));
    const correction = manager.appendMessage({ role: "user", content: "不要带解释", timestamp: 0 });
    manager.appendMessage(assistant("{}"));
    manager.appendCompaction("后续摘要不应泄漏", correction, 100);
    const context = contextAt(await scan(manager), cutoff);
    assert.deepEqual(context.input.map((entry) => entry.message), [{ role: "user", content: "只输出 JSON" }]);
    assert.deepEqual(context.observed, { role: "assistant", content: "好的，{}" });
    assert.deepEqual(context.followup, [{ role: "user", content: "不要带解释" }]);
    const result = lintCase(draftCase(context, "test"), { stage: "confirm", source: contextSource(context) });
    assert.equal(result.valid, true, JSON.stringify(result.issues));
    assert.equal(result.cutoffVerified, true);
});

test("截止点之前的压缩使用宿主摘要和保留消息，不恢复已丢弃的历史", async () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "已被压缩的原文", timestamp: 0 });
    manager.appendMessage(assistant("旧回复"));
    const kept = manager.appendMessage({ role: "user", content: "只输出 JSON", timestamp: 0 });
    manager.appendCompaction("压缩后的摘要", kept, 100);
    const cutoff = manager.appendMessage(assistant("好的，{}"));
    const context = contextAt(await scan(manager), cutoff);
    assert.equal(context.input.length, 2);
    assert.match(context.input[0].message.content!, /压缩后的摘要/);
    assert.deepEqual(context.input[1].message, { role: "user", content: "只输出 JSON" });
    assert.doesNotMatch(JSON.stringify(context.input), /已被压缩的原文|旧回复/);
});

test("Pi context_edit 只在编辑发生之后影响上下文", async () => {
    const manager = SessionManager.inMemory();
    const user = manager.appendMessage({ role: "user", content: "最初要求", timestamp: 0 });
    manager.appendContextEdit(user, { content: "只输出 JSON" });
    const cutoff = manager.appendMessage(assistant("好的，{}"));
    manager.appendContextEdit(user, { content: "未来改写" });
    const context = contextAt(await scan(manager), cutoff);
    assert.deepEqual(context.input.map((entry) => entry.message), [{ role: "user", content: "只输出 JSON" }]);
});

test("根节点 assistant 的输入为空，不会把当前分支当作父上下文", async () => {
    const manager = SessionManager.inMemory();
    const cutoff = manager.appendMessage(assistant("无前置要求"));
    manager.appendMessage({ role: "user", content: "未来的用户要求", timestamp: 0 });
    const context = contextAt(await scan(manager), cutoff);
    assert.deepEqual(context.input, []);
    assert.deepEqual(context.system, { status: "missing", content: null });
});

test("OMP redactedThinking 不导出，但保留省略记录", () => {
    const converted = convertMessage({ role: "assistant", content: [
        { type: "redactedThinking" }, { type: "text", text: "可见回复" },
    ] }, "diagnostic.observed");
    assert.deepEqual(converted.message, { role: "assistant", content: "可见回复" });
    assert.deepEqual(converted.transforms.map(({ type, target }) => ({ type, target })), [
        { type: "drop_thinking", target: "diagnostic.observed" },
    ]);
});

test("OMP callable 工具 schema 导出后仍保留必填字段和枚举约束", async () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "user", content: "只输出 JSON", timestamp: 0 });
    const cutoff = manager.appendMessage(assistant("好的，{}"));
    const parameters = OmpType.Object({
        path: OmpType.String(),
        mode: OmpType.Optional(OmpType.Union([OmpType.Literal("text"), OmpType.Literal("raw")])),
    });
    const snapshot = await readSession({ sessionManager: manager, piSdk } as WorkflowContext, {
        getActiveTools: () => ["read"],
        getAllTools: () => [{ name: "read", description: "读取文件", parameters }],
    } as unknown as ExtensionAPI);
    const doc = draftCase(contextAt(snapshot, cutoff), "test");
    const saved = JSON.parse(JSON.stringify(doc));
    const accepts = new Ajv2020().compile(saved.task.tools.definitions[0].function.parameters);
    assert.equal(accepts({ path: "README.md" }), true);
    assert.equal(accepts({ path: "README.md", mode: "raw" }), true);
    assert.equal(accepts({ mode: "raw" }), false);
    assert.equal(accepts({ path: 42 }), false);
    assert.equal(accepts({ path: "README.md", mode: "invalid" }), false);
});
