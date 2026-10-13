import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/store/config.ts";
import { callModel, prepareRequests, resolveDraftModel } from "../src/pi/model.ts";

const directory = await mkdtemp(join(tmpdir(), "casepick-model-"));
process.env.XDG_DATA_HOME = directory;
after(() => rm(directory, { recursive: true, force: true }));

const astra = { provider: "acme", id: "astra", name: "Astra", reasoning: true };
const plain = { provider: "acme", id: "plain", name: "Plain", reasoning: false };

function context(options: { model?: object; auth?: boolean; calls?: unknown[] } = {}) {
    return {
        model: "model" in options ? options.model : astra,
        modelRegistry: {
            getAvailable: () => [astra, plain],
            find: (provider: string, id: string) => [astra, plain].find((item) => item.provider === provider && item.id === id),
            hasConfiguredAuth: () => options.auth ?? true,
            streamSimple: (model: object, ctx: unknown, opts: unknown) => {
                options.calls?.push({ model, ctx, opts });
                return { result: async () => ({ role: "assistant", content: [{ type: "text", text: "{\"ok\":true}" }], usage: { input: 10, output: 3 }, stopReason: "stop" }) };
            },
        },
    } as unknown as ExtensionCommandContext;
}

test("默认跟随当前模型，思考等级 low", () => {
    const result = resolveDraftModel(context(), defaultConfig());
    assert.ok(result.ok);
    assert.equal(result.value.label, "Astra · low");
    assert.equal(result.value.key, "acme/astra");
});

test("当前模型不支持思考时不传思考等级", () => {
    const result = resolveDraftModel(context({ model: plain }), defaultConfig());
    assert.ok(result.ok);
    assert.equal(result.value.reasoning, undefined);
    assert.equal(result.value.note, "该模型不支持思考等级");
});

test("固定模型、不使用模型、没有当前模型、没有凭据", () => {
    const config = defaultConfig();
    config.drafting.model = { mode: "fixed", provider: "acme", id: "plain" };
    const fixed = resolveDraftModel(context(), config);
    assert.ok(fixed.ok && fixed.value.key === "acme/plain");
    config.drafting.model = { mode: "fixed", provider: "acme", id: "gone" };
    assert.match((resolveDraftModel(context(), config) as { reason: string }).reason, /找不到/);
    config.drafting.model = { mode: "off" };
    assert.equal(resolveDraftModel(context(), config).ok, false);
    assert.match((resolveDraftModel(context({ model: undefined }), defaultConfig()) as { reason: string }).reason, /没有选定模型/);
    assert.match((resolveDraftModel(context({ auth: false }), defaultConfig()) as { reason: string }).reason, /凭据/);
});

test("调用时带上思考等级和输出上限，不传工具，并记录用量", async () => {
    const calls: { ctx: { tools?: unknown; systemPrompt: string }; opts: { reasoning?: string; maxTokens: number } }[] = [];
    const ctx = context({ calls });
    const resolved = resolveDraftModel(ctx, defaultConfig());
    assert.ok(resolved.ok);
    const reply = await callModel(ctx, defaultConfig(), resolved.value, { system: "系统", user: "消息" });
    assert.equal(reply.text, "{\"ok\":true}");
    assert.equal(calls[0].opts.reasoning, "low");
    assert.equal(calls[0].opts.maxTokens, 8000);
    assert.equal(calls[0].ctx.tools, undefined);
    assert.equal(calls[0].ctx.systemPrompt, "系统");
    const usage = await readFile(join(directory, "casepick", "usage.jsonl"), "utf8");
    assert.match(usage, /"model":"acme\/astra"/);
    assert.doesNotMatch(usage, /消息|系统/);
});

test("外发前脱敏并统计命中", () => {
    const [request] = prepareRequests([{ system: "s", user: "token sk-abcdefghijklmnopqrstuv" }]);
    assert.doesNotMatch(request.prompt.user, /sk-abc/);
    assert.deepEqual(request.hits, [{ kind: "api_key", count: 1 }]);
});
