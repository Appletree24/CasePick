import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { deriveEventMessage, foldRequestHeader, foldSurface, SessionId, SessionSeq, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import { createDshSources } from "../src/dsh/sessions.ts";
import { sessionKeyOf } from "../src/pi/read-session.ts";
import { sourceReferences } from "../src/pi/sources.ts";

function fixture() {
    const events: SessionEvent[] = [];
    const header: SessionHeader = { version: 3, id: SessionId("child-session"), createdAt: 1700000000000, cwd: "/workspace", isSeeded: true, parentSession: SessionId("parent-session") };
    function add(type: SessionEvent["type"], data: unknown, surface?: { surfaceOp: "append" | { op: "replace"; startSeq: SessionSeq; endSeq: SessionSeq }; sourceEventSeqs?: SessionSeq[] }) {
        const event = { type, data, seq: SessionSeq(events.length), time: header.createdAt + events.length, ...surface } as SessionEvent;
        events.push(event);
        return event.seq;
    }
    const system = add("system/message", { turn: 0, step: 0, message: createSystemMessage("原始指令", "system") }, { surfaceOp: "append" });
    const user = add("user/message", createUserMessage({ content: [{ type: "text", text: "保留历史要求" }], source: { kind: "user" } }), { surfaceOp: "append" });
    const callId = ToolCallId("call-native");
    const call = add("assistant/message", { turn: 0, step: 0, stream: [], message: createAssistantMessage({ source: { provider: "native", model: "exact" }, content: [{ type: "tool-call", id: callId, name: "read", arguments: '{ "path" : "a" }' }] }) }, { surfaceOp: "append" });
    const tool = add("tool/result", { turn: 0, step: 0, message: createToolResultMessage({ callId, content: [{ type: "text", text: "文件原文" }], isError: true }) }, { surfaceOp: "append" });
    add("session/end-seed", { inherited: true });
    add("request/header", { reason: "resume", header: { config: { provider: "native", model: "exact" }, tools: [{ name: "read", description: "历史工具", parameters: { type: "object" } }] } });
    const candidate = add("assistant/message", { turn: 1, step: 0, stream: [], interrupted: true, message: createAssistantMessage({ source: { provider: "native", model: "exact" }, content: [{ type: "reasoning", text: "私有思考" }, { type: "text", text: "出错回复" }] }) }, { surfaceOp: "append" });
    add("user/message", createUserMessage({ content: [{ type: "text", text: "后来的纠正" }], source: { kind: "user" } }), { surfaceOp: "append" });
    const ctx = {} as Context;
    const agent = { session: { header, inheritedEventCount: 4, firstLiveSeq: 5, snapshotEvents: () => [...events] } } as unknown as Agent;
    const source = createDshSources(ctx, agent, new AbortController().signal);
    return { events, header, system, user, call, tool, candidate, add, ctx, agent, source };
}

test("DSH cutoff uses native prefix folds, preserving fork history, exact tools and tool-result roles without later leakage", async () => {
    const f = fixture();
    f.add("assistant/attempt", { turn: 2, step: 0, stream: [] });
    f.add("system/message", { turn: 2, step: 0, message: createSystemMessage("未来指令", "system") }, { surfaceOp: { op: "replace", startSeq: f.system, endSeq: f.system }, sourceEventSeqs: [f.system] });
    f.add("user/message", createUserMessage({ content: [{ type: "text", text: "未来压缩摘要" }], source: { kind: "plugin", plugin: "compaction" } }), { surfaceOp: { op: "replace", startSeq: f.user, endSeq: f.tool }, sourceEventSeqs: [f.user, f.call, f.tool] });
    f.add("request/header", { reason: "change", header: { config: { provider: "native", model: "other" } } });
    const later = f.add("assistant/message", { turn: 2, step: 0, stream: [], message: createAssistantMessage({ source: { provider: "native", model: "other" }, content: [{ type: "text", text: "后来的答案" }] }) }, { surfaceOp: "append" });
    const before = structuredClone(f.events);
    const snapshot = await f.source.readCurrent();
    const context = snapshot.contextAt(`dsh:${f.candidate}`);
    const prefix = f.events.slice(0, f.candidate);
    const native = foldSurface(prefix).nodes.map((seq) => deriveEventMessage(prefix[seq])).filter((message) => message !== null);
    assert.equal(native.length, 4);
    assert.equal(context.system.content, "原始指令");
    assert.equal(context.system.status, "captured");
    assert.deepEqual(context.input.map((entry) => entry.id), [`dsh:${f.user}`, `dsh:${f.call}`, `dsh:${f.tool}`]);
    assert.deepEqual(context.input.map((entry) => entry.message.role), ["user", "assistant", "tool"]);
    assert.equal(context.input[1].message.role === "assistant" && context.input[1].message.tool_calls?.[0].function.arguments, '{ "path" : "a" }');
    assert.equal(context.input[2].toolError, true);
    assert.deepEqual(context.input[2].message, { role: "tool", tool_call_id: "call-native", content: "文件原文" });
    assert.deepEqual(context.followup, [{ role: "user", content: "后来的纠正" }]);
    assert.equal(context.tools.definitions?.[0].function.description, foldRequestHeader(prefix)?.tools?.[0].description);
    assert.equal(context.observed.content, "出错回复");
    assert.ok(context.transforms.some((transform) => transform.type === "drop_thinking"));
    assert.equal(snapshot.messages.find((entry) => entry.id === `dsh:${f.candidate}`)?.interrupted, true);
    assert.equal(snapshot.messages.some((entry) => entry.message.content === "未来压缩摘要"), false);
    assert.doesNotMatch(JSON.stringify(context.input), /未来|后来的|出错回复/);
    const compacted = snapshot.contextAt(`dsh:${later}`);
    assert.equal(compacted.system.content, "未来指令");
    assert.equal(compacted.input[0].message.content, "未来压缩摘要");
    assert.deepEqual(compacted.tools, { source: "none", definitions: [] });
    assert.deepEqual(f.events, before);
    assert.equal(f.source.current(snapshot).id, "dsh:child-session");
    assert.equal(snapshot.sessionKey, sessionKeyOf("dsh:child-session"));
    assert.ok(snapshot.branch.every((entry) => entry.type !== "message" && entry.type !== "custom_message"));
    // A resumed source can append after capture without changing identities or the frozen cut.
    f.add("user/message", createUserMessage({ content: [{ type: "text", text: "snapshot 后追加" }], source: { kind: "user" } }), { surfaceOp: "append" });
    assert.deepEqual(snapshot.contextAt(`dsh:${f.candidate}`), context);
});

test("DSH external reads dispose the native read-only lease and references identify sessions, never invent source reply IDs", async () => {
    const f = fixture();
    f.add("user/message", createUserMessage({ content: [{ type: "text", text: "外部会话材料" }], source: { kind: "session-reference", form: "recall", version: 1, references: [{ sessionId: "origin", label: "原始会话", capturedThroughSeq: SessionSeq(12), compacted: true, originalMessages: 9, retainedMessages: 3, omittedMessages: 6, omittedBytes: 80, truncated: false, inputIndex: 0 }] } }), { surfaceOp: "append" });
    let disposed = 0;
    const signal = new AbortController().signal;
    const externalHeader = { ...f.header, id: SessionId("external") };
    const eventsBefore = structuredClone(f.events);
    const ctx = { sessionQuery: {
        listSessions: async () => [{ header: externalHeader, live: false, persisted: true }],
        observeSession: async (id: string, options: { signal: AbortSignal; projectionMode: string }) => {
            assert.equal(id, "external");
            assert.equal(options.signal, signal);
            assert.equal(options.projectionMode, "none");
            return { header: externalHeader, events: f.events, [Symbol.dispose]() { disposed++; } };
        },
    } } as unknown as Context;
    const source = createDshSources(ctx, f.agent, signal);
    const choices = await source.list();
    assert.equal(choices[0].path, "dsh:external");
    assert.equal(choices[0].modified, undefined);
    assert.equal(choices[0].created?.getTime(), f.header.createdAt);
    const external = await source.load(choices[0].path);
    assert.equal(external.external, true);
    assert.equal(external.snapshot.sessionKey, sessionKeyOf("dsh:external"));
    const raw = await source.load("external");
    assert.equal(raw.key, external.key);
    assert.equal(raw.id, external.id);
    const references = sourceReferences(external.snapshot);
    assert.equal(references[0].sessionId, "dsh:origin");
    assert.equal(references[0].sourceEntry, undefined);
    assert.match(references[0].preview, /12.*摘录/);
    assert.equal(disposed, 2);
    assert.deepEqual(f.events, eventsBefore);
    await assert.rejects(source.load("/pretended/session.jsonl"), /不是 DSH/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createDshSources(ctx, f.agent, controller.signal).readCurrent(), { name: "AbortError" });
});

test("DSH preserves an explicit empty system and marks in-history flattening approximate", async () => {
    const f = fixture();
    f.add("system/message", { turn: 2, step: 0, message: createSystemMessage("新增完整指令", "system") }, { surfaceOp: "append" });
    const later = f.add("assistant/message", { turn: 2, step: 0, stream: [], message: createAssistantMessage({ source: { provider: "native", model: "exact" }, content: [{ type: "text", text: "答案" }] }) }, { surfaceOp: "append" });
    const snapshot = await f.source.readCurrent();
    const context = snapshot.contextAt(`dsh:${later}`);
    assert.equal(context.system.status, "approximate");
    assert.equal(context.system.content, "原始指令\n\n新增完整指令");
    const emptyEvents: SessionEvent[] = [
        { type: "system/message", seq: SessionSeq(0), time: 0, surfaceOp: "append", data: { turn: 0, step: 0, message: createSystemMessage("", "system") } },
        { type: "assistant/message", seq: SessionSeq(1), time: 1, surfaceOp: "append", data: { turn: 0, step: 0, stream: [], message: createAssistantMessage({ source: { provider: "native", model: "exact" }, content: [{ type: "text", text: "答案" }] }) } },
    ];
    const agent = { session: { header: f.header, snapshotEvents: () => emptyEvents } } as unknown as Agent;
    const empty = await createDshSources(f.ctx, agent, new AbortController().signal).readCurrent();
    assert.deepEqual(empty.contextAt("dsh:1").system, { status: "captured", content: "" });
    assert.equal(empty.contextAt("dsh:1").tools.source, "approximate");
    assert.throws(() => empty.contextAt("dsh:0"), /原始 assistant/);
    const missingAgent = { session: { header: f.header, snapshotEvents: () => [{ ...emptyEvents[1], seq: SessionSeq(0) }] } } as unknown as Agent;
    const missing = await createDshSources(f.ctx, missingAgent, new AbortController().signal).readCurrent();
    assert.deepEqual(missing.contextAt("dsh:0").system, { status: "missing", content: null });
});
