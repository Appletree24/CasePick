import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createAssistantMessage, createDeveloperMessage, createSystemMessage, createToolResultMessage, createUserMessage, freezeMessage, ToolCallId, type Message as NativeMessage } from "@deepseek-ai/dsh-llm";
import { deriveEventMessage, foldRequestHeader, foldSurface, SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent, type SessionHeader, type SessionMessageProjection } from "@deepseek-ai/dsh-session";
import { createDshSources } from "../src/dsh/sessions.ts";
import { sessionKeyOf } from "../src/pi/read-session.ts";
import { sourceReferences } from "../src/pi/sources.ts";

declare module "@deepseek-ai/dsh-llm" {
    interface MessageSourceMap {
        "casepick-test": { kind: "casepick-test" };
    }
}

declare module "@deepseek-ai/dsh-session" {
    interface SessionEventMap {
        "casepick-test/rewrite": { target: SessionSeq; text: string };
    }
}

function fixture() {
    const events: SessionEvent[] = [];
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId("child-session"), createdAt: 1700000000000, cwd: "/workspace", isSeeded: true, parentSession: SessionId("parent-session") };
    function add(type: SessionEvent["type"], data: unknown, surface?: { surfaceOp: "append" | { op: "replace"; startSeq: SessionSeq; endSeq: SessionSeq }; sourceEventSeqs?: SessionSeq[] }) {
        const event = { type, data, seq: SessionSeq(events.length), time: header.createdAt + events.length, ...surface } as SessionEvent;
        events.push(event);
        return event.seq;
    }
    const system = add("system/message", { turn: 0, step: 0, message: createSystemMessage("原始指令") }, { surfaceOp: "append" });
    const user = add("user/message", createUserMessage({ content: [{ type: "text", text: "保留历史要求" }], source: { kind: "user" } }), { surfaceOp: "append" });
    const callId = ToolCallId("call-native");
    const call = add("assistant/message", { turn: 0, step: 0, stream: [], message: createAssistantMessage({ source: { provider: "native", model: "exact" }, content: [{ type: "tool-call", id: callId, name: "read", arguments: '{ "path" : "a" }' }] }) }, { surfaceOp: "append" });
    add("tool/call", { turn: 0, step: 0, callId, name: "read", arguments: '{ "path" : "a" }' });
    const tool = add("tool/result", { turn: 0, step: 0, message: createToolResultMessage({ callId, content: [{ type: "text", text: "文件原文" }], isError: true }) }, { surfaceOp: "append" });
    add("session/end-seed", { inherited: true });
    add("request/header", { reason: "resume", header: { config: { provider: "native", model: "exact" }, tools: [{ name: "read", description: "历史工具", parameters: { type: "object" } }] } });
    const candidate = add("assistant/message", { turn: 1, step: 0, stream: [], interrupted: true, message: createAssistantMessage({ source: { provider: "native", model: "exact" }, content: [{ type: "reasoning", text: "私有思考" }, { type: "text", text: "出错回复" }] }) }, { surfaceOp: "append" });
    add("user/message", createUserMessage({ content: [{ type: "text", text: "后来的纠正" }], source: { kind: "user" } }), { surfaceOp: "append" });
    const projections: SessionMessageProjection[] = [];
    const ctx = { sessions: { messageProjections: projections } } as unknown as Context;
    const agent = { session: { header, inheritedEventCount: tool + 1, firstLiveSeq: tool + 2, snapshotEvents: () => [...events] } } as unknown as Agent;
    const source = createDshSources(ctx, agent, new AbortController().signal);
    return { events, header, system, user, call, tool, candidate, add, ctx, agent, source, projections };
}

test("DSH cutoff uses native prefix folds, preserving fork history, exact tools and tool-result roles without later leakage", async () => {
    const f = fixture();
    f.add("assistant/attempt", { turn: 2, step: 0, stream: [] });
    f.add("system/message", { turn: 2, step: 0, message: createSystemMessage("未来指令") }, { surfaceOp: { op: "replace", startSeq: f.system, endSeq: f.system }, sourceEventSeqs: [f.system] });
    f.add("user/message", createUserMessage({ content: [{ type: "text", text: "未来压缩摘要" }], source: { kind: "casepick-test" } }), { surfaceOp: { op: "replace", startSeq: f.user, endSeq: f.tool }, sourceEventSeqs: [f.user, f.call, f.tool] });
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
    const ctx = { sessions: f.ctx.sessions, sessionQuery: {
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
    f.add("system/message", { turn: 2, step: 0, message: createSystemMessage("新增完整指令") }, { surfaceOp: "append" });
    const later = f.add("assistant/message", { turn: 2, step: 0, stream: [], message: createAssistantMessage({ source: { provider: "native", model: "exact" }, content: [{ type: "text", text: "答案" }] }) }, { surfaceOp: "append" });
    const snapshot = await f.source.readCurrent();
    const context = snapshot.contextAt(`dsh:${later}`);
    assert.equal(context.system.status, "approximate");
    assert.equal(context.system.content, "原始指令\n\n新增完整指令");
    const emptyEvents: SessionEvent[] = [
        { type: "system/message", seq: SessionSeq(0), time: 0, surfaceOp: "append", data: { turn: 0, step: 0, message: createSystemMessage("") } },
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

test("DSH format4 preserves developer instructions and records lossy tool-update/deferred-declaration boundaries", async () => {
    const f = fixture();
    const header = f.add("request/header", { reason: "change", header: {
        config: { provider: "native", model: "exact" },
        tools: [{ name: "search", description: "动态工具", parameters: { type: "object" }, deferLoading: true }],
    } });
    f.add("developer/message", { turn: 2, step: 0, headerSeq: header, message: createDeveloperMessage({
        source: { kind: "casepick-test" },
        content: [{ type: "text", text: "必须保留的 developer 指令" }, { type: "tool-addition", toolName: "search" }],
    }) }, { surfaceOp: "append" });
    const candidate = f.add("assistant/message", { turn: 2, step: 0, stream: [], message: createAssistantMessage({
        source: { provider: "native", model: "exact" }, content: [{ type: "text", text: "动态工具之后" }],
    }) }, { surfaceOp: "append" });
    f.add("developer/message", { turn: 3, step: 0, message: createDeveloperMessage({
        source: { kind: "casepick-test" }, content: [{ type: "tool-removal", toolName: "search" }],
    }) }, { surfaceOp: "append" });
    f.add("request/header", { reason: "change", header: { config: { provider: "native", model: "exact" } } });
    const later = f.add("assistant/message", { turn: 3, step: 0, stream: [], message: createAssistantMessage({
        source: { provider: "native", model: "exact" }, content: [{ type: "text", text: "工具移除之后" }],
    }) }, { surfaceOp: "append" });
    const snapshot = await f.source.readCurrent();
    const context = snapshot.contextAt(`dsh:${candidate}`);
    assert.equal(context.hostVersion, "DSH/session-format-4");
    assert.deepEqual(context.system, { status: "approximate", content: "原始指令\n\n必须保留的 developer 指令" });
    assert.ok(context.limitations.some((item) => item.field === "task.system" && /developer/.test(item.note ?? "")));
    assert.ok(context.limitations.some((item) => item.field === "task.messages" && /工具增删/.test(item.note ?? "")));
    assert.ok(context.limitations.some((item) => item.field === "task.tools" && /deferLoading/.test(item.note ?? "")));
    assert.deepEqual(context.tools, { source: "captured", definitions: [{
        type: "function", function: { name: "search", description: "动态工具", parameters: { type: "object" } },
    }] });
    assert.deepEqual(snapshot.contextAt(`dsh:${later}`).tools, { source: "none", definitions: [] });
    assert.equal(context.input.some((entry) => entry.message.content?.includes("developer")), false);
    assert.deepEqual(context.followup, []);
});

test("DSH reconstructs registered message projections at each historical prefix, never at the latest surface", async () => {
    const f = fixture();
    const projection: SessionMessageProjection<"casepick-test/rewrite"> = {
        type: "casepick-test/rewrite",
        project(event, context) {
            const original: NativeMessage | null | undefined = context.messages.get(event.data.target)
                ?? deriveEventMessage(context.events[event.data.target - context.baseSeq]);
            assert.ok(original);
            return new Map([[event.data.target, freezeMessage({ ...original, content: [{ type: "text", text: event.data.text }] })]]);
        },
    };
    f.projections.push(projection);
    f.add("casepick-test/rewrite", { target: f.user, text: "历史投影后的要求" });
    const candidate = f.add("assistant/message", { turn: 2, step: 0, stream: [], message: createAssistantMessage({
        source: { provider: "native", model: "exact" }, content: [{ type: "text", text: "投影之后" }],
    }) }, { surfaceOp: "append" });
    f.add("casepick-test/rewrite", { target: f.user, text: "未来投影的要求" });
    const snapshot = await f.source.readCurrent();
    assert.equal(snapshot.messages.find((entry) => entry.id === `dsh:${f.user}`)?.message.content, "保留历史要求");
    assert.equal(snapshot.contextAt(`dsh:${f.candidate}`).input[0].message.content, "保留历史要求");
    assert.equal(snapshot.contextAt(`dsh:${candidate}`).input[0].message.content, "历史投影后的要求");
    const native = foldSurface(f.events.slice(0, candidate), [projection]);
    assert.equal(deriveEventMessage(f.events[f.user], native.projectedMessages)?.content[0].type, "text");
    // The selected snapshot owns its interpreter list as well as its event log.
    f.projections.length = 0;
    assert.equal(snapshot.contextAt(`dsh:${candidate}`).input[0].message.content, "历史投影后的要求");
});

test("DSH format4 tool results keep the top-level native call identity and reject contradictory associations", async () => {
    const f = fixture();
    const event = f.events[f.tool];
    assert.equal(event.type, "tool/result");
    if (event.type !== "tool/result") throw new Error("missing tool fixture");
    assert.equal(event.data.message.role, "tool");
    assert.equal(event.data.message.content[0].type, "text");
    f.events[f.tool] = { ...event, data: { ...event.data, message: {
        ...event.data.message, toolCallId: ToolCallId("wrong-call"),
    } } };
    await assert.rejects(f.source.readCurrent(), /调用关联无效/);
});
