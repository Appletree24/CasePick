import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { ModelSelectionProjectionState } from "@deepseek-ai/dsh-api-session-controller/types";
import { LlmAdapter, LlmError, LlmRuntime, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from "@deepseek-ai/dsh-llm";
import type { Context as PortableContext } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox/type";
import { createDshModels } from "../src/dsh/models.ts";
import { supportedLevels } from "../src/core/reasoning.ts";

// Exercise the real registry preparation, validation, terminal normalization and
// BlockAssembler, with a deterministic in-process provider: no credentials or network.
class NativeProvider extends LlmAdapter {
    calls: GenerateOptions[] = [];
    mode: "success" | "failure" | "aborted" | "truncated" | "unknown-usage" | "unterminated" | "wait" = "success";
    onWait?: () => void;
    async listModels(provider: string) {
        return [{ provider, id: "advertised", name: "Advertised" }];
    }
    async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
        if (id === "missing") throw new LlmError("removed model", "MODEL_NOT_FOUND");
        return { provider, id, name: `Native ${id}`, inputModalities: ["text"], context: { contextWindow: 100000 }, defaultMaxTokens: 3000,
            reasoning: { efforts: [{ id: ReasoningEffortId("low"), name: "Low" }, { id: ReasoningEffortId("native-deep"), name: "Opaque deep" }] } };
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.calls.push(options);
        if (this.mode === "wait") {
            await new Promise<void>((_resolve, reject) => {
                if (options.signal?.aborted) { reject(options.signal.reason); return; }
                options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
                this.onWait?.();
            });
        }
        yield { type: "reasoning-delta", index: 0, text: "This is not JSON output" };
        yield { type: "text-delta", index: 1, text: '{"cases":' };
        if (this.mode === "failure") throw new LlmError("provider denied the request", "AUTH", { status: 401 });
        if (this.mode === "aborted") { yield { type: "finish", reason: { kind: "aborted", failure: { code: "CANCELLED", message: "native cancellation" } } }; return; }
        yield { type: "text-delta", index: 1, text: "[]}" };
        if (this.mode !== "unknown-usage") yield { type: "usage", usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 8, reasoningTokens: 3, totalTokens: 43 } };
        if (this.mode === "unterminated") return;
        yield { type: "finish", reason: { kind: this.mode === "truncated" ? "max-tokens" : "stop" } };
    }
}

async function setup(requested = ["native/private/model", "native/missing"]) {
    const ctx = new Context();
    const llm = new LlmRuntime(ctx);
    const provider = new NativeProvider();
    const unregister = llm.registerAdapter(["native"], provider);
    const options = Object.freeze({ provider: "native", model: "private/model", reasoningEffort: ReasoningEffortId("native-deep") });
    const selection: { value: ModelSelectionProjectionState | undefined } = { value: { pending: null, lastUsed: null } };
    // Fixtures implement only the read capabilities consumed by this adapter.
    const projections = { stateOf: () => selection.value } as unknown as Context["sessionProjections"];
    const defaults = { currentSelection: () => options } as unknown as Context["agentDefaultModel"];
    ctx.sessionProjections = projections;
    ctx.agentDefaultModel = defaults;
    const sourceEvents: unknown[] = [];
    const agent = { options, session: { snapshotEvents: () => sourceEvents } } as unknown as Agent;
    const controller = new AbortController();
    const result = await createDshModels(ctx, agent, controller.signal, requested);
    const prompt: PortableContext = { systemPrompt: "CasePick isolated request", messages: [{ role: "user", content: "Produce JSON only", timestamp: 0 }] };
    return { ...result, view: result, ctx, provider, unregister, options, sourceEvents, controller, prompt, selection };
}

test("native exact unadvertised model is selectable, absent models warn, opaque effort IDs never masquerade as canonical levels", async (t) => {
    const f = await setup();
    t.after(f.unregister);
    assert.equal(f.model?.id, "private/model");
    assert.equal(f.modelRegistry.find("native", "private/model"), f.model);
    assert.equal(f.modelRegistry.find("native", "missing"), undefined);
    assert.match(f.warnings?.join("\n") ?? "", /native\/missing.*removed model/);
    assert.ok(f.model);
    assert.deepEqual(supportedLevels(f.model), ["low"]);
    assert.equal(f.model.thinkingLevelMap?.high, null);
    assert.equal("cost" in f.model, false);
    assert.equal("baseUrl" in f.model, false);
    const stream = f.modelRegistry.streamSimple!;
    await assert.rejects(stream(f.model, f.prompt, { reasoning: "high" }).result(), /不支持思考等级 high/);
    await assert.rejects(stream(f.model, f.prompt, { apiKey: "must-not-be-used" }).result(), /不支持起草参数 apiKey/);
    await assert.rejects(stream(f.model, f.prompt, { thinkingBudgets: { low: 400 } }).result(), /不支持起草参数 thinkingBudgets/);
    await assert.rejects(stream(f.model, { ...f.prompt, tools: [{ name: "run", description: "", parameters: Type.Object({}) }] }).result(), /不支持工具/);
    assert.equal(f.provider.calls.length, 0);
});

test("native current model follows pending selection, then last request, then host default instead of stale Agent options", async (t) => {
    const f = await setup(["native/last", "native/next"]);
    t.after(f.unregister);
    f.selection.value = {
        lastUsed: { provider: "native", model: "last" },
        pending: { provider: "native", model: "next" },
    };
    assert.equal(f.view.model?.id, "next");
    f.selection.value = { ...f.selection.value, pending: null };
    assert.equal(f.view.model?.id, "last");
    f.selection.value = { ...f.selection.value, lastUsed: null };
    assert.equal(f.view.model?.id, "private/model");
    f.selection.value = undefined;
    assert.throws(() => f.view.model, /缺少 modelSelection 投影/);
});

test("native assembly returns visible JSON, aggregates disjoint input usage, and never changes conversation state", async (t) => {
    const f = await setup();
    t.after(f.unregister);
    assert.ok(f.model);
    const before = structuredClone(f.options);
    const reply = await f.modelRegistry.streamSimple!(f.model, f.prompt, { reasoning: "low", maxTokens: 77 }).result();
    assert.deepEqual(reply.content, [{ type: "text", text: '{"cases":[]}' }]);
    assert.equal(reply.stopReason, "stop");
    assert.equal(reply.usage.input, 35);
    assert.equal(reply.usage.output, 8);
    assert.equal(reply.usage.reasoning, 3);
    assert.equal(reply.usage.totalTokens, 43);
    assert.equal("cost" in reply.usage, false);
    assert.deepEqual(f.options, before);
    assert.deepEqual(f.sourceEvents, []);
    const native = f.provider.calls[0];
    assert.equal(native.sessionId, undefined);
    assert.equal(native.tools, undefined);
    assert.equal(native.purpose, undefined);
    assert.equal(native.messages.length, 1);
    assert.equal(native.messages[0].source?.kind, "casepick");
    assert.equal(native.reasoningEffort, "low");
    assert.equal(native.maxTokens, 77);
    assert.equal(Object.isFrozen(native.messages[0]), true);
    const firstId = native.messages[0].id;
    f.provider.mode = "unknown-usage";
    const unknown = await f.modelRegistry.streamSimple!(f.model, f.prompt).result();
    assert.equal(unknown.usage, undefined);
    assert.notEqual(f.provider.calls[1].messages[0].id, firstId);
    f.provider.mode = "truncated";
    assert.equal((await f.modelRegistry.streamSimple!(f.model, f.prompt).result()).stopReason, "length");
});

test("real native runtime terminal failures and unterminated streams cannot turn partial JSON into successful results", async (t) => {
    const f = await setup();
    t.after(f.unregister);
    assert.ok(f.model);
    for (const [mode, expected] of [["failure", /AUTH: provider denied/], ["aborted", /CANCELLED: native cancellation/], ["unterminated", /未返回终止状态/]] as const) {
        f.provider.mode = mode;
        await assert.rejects(f.modelRegistry.streamSimple!(f.model, f.prompt).result(), expected);
    }
    assert.deepEqual(f.sourceEvents, []);
});

test("caller cancellation, timeout and receiving-command cancellation stop only the isolated native request", async (t) => {
    const f = await setup();
    t.after(f.unregister);
    assert.ok(f.model);
    const cancelled = new AbortController();
    cancelled.abort(new Error("caller cancelled"));
    await assert.rejects(f.modelRegistry.streamSimple!(f.model, f.prompt, { signal: cancelled.signal }).result(), /caller cancelled/);
    assert.equal(f.provider.calls.length, 0);
    f.provider.mode = "wait";
    const timeout = new AbortController();
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
        assert.equal(milliseconds, 37);
        return timeout.signal;
    });
    f.provider.onWait = () => timeout.abort(new DOMException("deadline", "TimeoutError"));
    await assert.rejects(f.modelRegistry.streamSimple!(f.model, f.prompt, { timeoutMs: 37 }).result(), { name: "TimeoutError" });
    const inflight = new AbortController();
    f.provider.onWait = () => inflight.abort(new Error("in-flight caller cancelled"));
    await assert.rejects(f.modelRegistry.streamSimple!(f.model, f.prompt, { signal: inflight.signal }).result(), /in-flight caller cancelled/);
    f.provider.onWait = undefined;
    const pending = f.modelRegistry.streamSimple!(f.model, f.prompt).result();
    f.controller.abort(new Error("command cancelled"));
    await assert.rejects(pending, /command cancelled/);
    assert.deepEqual(f.sourceEvents, []);
});

test("historical helper models follow selected-session next, last and default without any active Agent or live projection", async (t) => {
    const f = await setup([]);
    t.after(f.unregister);
    f.selection.value = undefined;
    const source = { modelSelection: {
        next: { provider: "native", model: "history-pending" },
        lastUsed: { provider: "native", model: "history-last" },
    } };
    const selected = await createDshModels(f.ctx, source, f.controller.signal, ["native/history-last"]);
    assert.equal(selected.model?.id, "history-pending");
    assert.ok(selected.model);
    await selected.modelRegistry.streamSimple!(selected.model, f.prompt).result();
    assert.equal(f.provider.calls[0].model, "history-pending");
    assert.equal(f.provider.calls[0].sessionId, undefined);
    assert.equal(f.provider.calls[0].tools, undefined);
    const last = await createDshModels(f.ctx, { modelSelection: { next: null, lastUsed: source.modelSelection.lastUsed } }, f.controller.signal);
    assert.equal(last.model?.id, "history-last");
    const fallback = await createDshModels(f.ctx, {}, f.controller.signal);
    assert.equal(fallback.model?.id, "private/model");
    assert.deepEqual(f.sourceEvents, []);
});
