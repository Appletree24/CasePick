import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/store/config.ts";
import { callModel, prepareRequests, resolveDraftModel } from "../src/pi/model.ts";
import { parseOverrides } from "../src/pi/plugin-settings.ts";

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
    const reply = await callModel(ctx, resolved.value, { system: "系统", user: "消息" });
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

test("OMP 给 casepick 角色指派了模型时优先使用，否则跟随当前模型", () => {
    const withRole = { ...context(), models: { resolve: (spec: string) => (spec === "@casepick" ? plain : undefined) } } as unknown as ExtensionCommandContext;
    const result = resolveDraftModel(withRole, defaultConfig());
    assert.ok(result.ok);
    assert.equal(result.value.key, "acme/plain");
    assert.match(result.value.label, /OMP 角色 @casepick/);
    const noRole = { ...context(), models: { resolve: () => undefined } } as unknown as ExtensionCommandContext;
    const fallback = resolveDraftModel(noRole, defaultConfig());
    assert.ok(fallback.ok && fallback.value.key === "acme/astra");
    // 固定模型时不看角色。
    const config = defaultConfig();
    config.drafting.model = { mode: "fixed", provider: "acme", id: "astra" };
    const fixed = resolveDraftModel(withRole, config);
    assert.ok(fixed.ok && fixed.value.key === "acme/astra");
});

test("OMP 插件设置里填了值的项覆盖 /casepick config", async () => {
    const { loadPluginSettings, parseOverrides } = await import("../src/pi/plugin-settings.ts");
    const plugin = await loadPluginSettings("/work", true, async (name) => {
        assert.equal(name, "casepick");
        return { draftModel: "acme/plain", reasoning: "high", maxOutputTokens: 4000, timeoutSeconds: "" };
    });
    assert.deepEqual(plugin.overrides, { model: "acme/plain", reasoning: "high", maxOutputTokens: 4000 });
    const resolved = resolveDraftModel(context(), defaultConfig(), plugin.overrides);
    assert.ok(resolved.ok);
    assert.equal(resolved.value.key, "acme/plain");
    // 不支持思考的模型不传思考等级，即使插件设置填了 high。
    assert.equal(resolved.value.reasoning, undefined);
    assert.equal(resolved.value.maxOutputTokens, 4000);
    assert.equal(resolved.value.timeoutSeconds, 120);
    assert.match(resolved.value.label, /OMP 插件设置/);

    const high = resolveDraftModel(context(), defaultConfig(), { reasoning: "high" });
    assert.ok(high.ok && high.value.reasoning === "high" && high.value.key === "acme/astra");
    assert.equal(resolveDraftModel(context(), defaultConfig(), { model: "off" }).ok, false);
    assert.equal(resolveDraftModel(context(), defaultConfig(), { model: "acme/gone" }).ok, false);
    const role = { ...context(), models: { resolve: (spec: string) => (spec === "@review" ? plain : undefined) } } as unknown as ExtensionCommandContext;
    const byRole = resolveDraftModel(role, defaultConfig(), { model: "@review" });
    assert.ok(byRole.ok && byRole.value.key === "acme/plain");

    const invalid = parseOverrides({ reasoning: "ultra", maxOutputTokens: 5, draftModel: 3 });
    assert.deepEqual(invalid.overrides, {});
    assert.equal(invalid.warnings.length, 3);
});

test("debug 显式关闭不能被当成未设置，字符串布尔值不能打开调试", () => {
    assert.deepEqual(parseOverrides({ debug: false }), { overrides: { debug: false }, warnings: [] });
    assert.deepEqual(parseOverrides({ debug: true }), { overrides: { debug: true }, warnings: [] });
    const invalid = parseOverrides({ debug: "false" });
    assert.deepEqual(invalid.overrides, {});
    assert.equal(invalid.warnings.length, 1);
});

test("Pi 上读不到插件设置时不提示，OMP 上读不到时提示", async () => {
    const { loadPluginSettings } = await import("../src/pi/plugin-settings.ts");
    const pi = await loadPluginSettings("/work", false);
    assert.deepEqual(pi, { overrides: {}, warnings: [], available: false });
    const omp = await loadPluginSettings("/work", true);
    assert.equal(omp.warnings.length, 1);
    const failing = await loadPluginSettings("/work", true, async () => { throw new Error("锁文件损坏"); });
    assert.match(failing.warnings[0], /锁文件损坏/);
});
