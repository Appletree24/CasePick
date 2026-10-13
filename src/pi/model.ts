// 起草模型：解析用哪个模型和思考等级、外发确认、调用、用量记录（技术设计第 8 节③、第 10 节）。
// 不调用 setModel / setThinkingLevel，不往会话里插消息，不传工具。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { join } from "node:path";
import type { Prompt } from "../core/assist.ts";
import { resolveReasoning, type ReasoningLevel } from "../core/reasoning.ts";
import { redact, type RedactionHit } from "../core/redact.ts";
import { appendLine, dataDir } from "../store/cases.ts";
import { saveConfig, type Config } from "../store/config.ts";
import type { PluginOverrides } from "./plugin-settings.ts";
import { showText } from "./ui.ts";

export interface DraftModel {
    model: Model<Api>;
    key: string;                       // provider/id，用于外发同意记录
    label: string;                     // 显示给用户，如 "Astra · low"
    reasoning: ReasoningLevel | undefined;
    note?: string;
    maxOutputTokens: number;
    timeoutSeconds: number;
}

export function modelKey(model: { provider: string; id: string }): string {
    return `${model.provider}/${model.id}`;
}

function modelName(model: Model<Api>): string {
    return (model as { name?: string }).name || model.id;
}

export type ResolveResult = { ok: true; value: DraftModel } | { ok: false; reason: string };

// OMP 的模型角色：用户在 /model 面板里给 casepick 角色指派模型。Pi 没有 ctx.models，返回 undefined。
export const modelRole = "casepick";

function hostResolve(ctx: ExtensionCommandContext, spec: string): Model<Api> | undefined {
    const models = (ctx as { models?: { resolve(spec: string): Model<Api> | undefined } }).models;
    try {
        return models?.resolve(spec);
    } catch {
        return undefined;
    }
}

export function roleModel(ctx: ExtensionCommandContext): Model<Api> | undefined {
    return hostResolve(ctx, `@${modelRole}`);
}

// OMP 插件设置里的 draftModel：current、off、@角色、provider/id，或宿主能识别的模型名。
function modelFromSpec(ctx: ExtensionCommandContext, spec: string): Model<Api> | undefined {
    const resolved = hostResolve(ctx, spec);
    if (resolved) return resolved;
    const slash = spec.indexOf("/");
    if (slash <= 0) return undefined;
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    return ctx.modelRegistry.getAvailable().find((item) => item.provider === provider && item.id === id) ?? ctx.modelRegistry.find(provider, id);
}

// 每次起草时解析：跟随当前模型时取发起这一刻的会话模型，不在配置里写死。
// overrides 来自 OMP 插件设置，填了值的项优先。
export function resolveDraftModel(ctx: ExtensionCommandContext, config: Config, overrides: PluginOverrides = {}): ResolveResult {
    const choice = config.drafting.model;
    const spec = overrides.model;
    let model: Model<Api> | undefined;
    let origin = "";
    if (spec !== undefined && spec.toLowerCase() === "off") {
        return { ok: false, reason: "OMP 插件设置里 draftModel 为 off，不使用起草模型" };
    } else if (spec !== undefined && spec.toLowerCase() === "current") {
        model = ctx.model as Model<Api> | undefined;
        origin = "OMP 插件设置：当前模型";
        if (!model) return { ok: false, reason: "当前会话没有选定模型" };
    } else if (spec !== undefined) {
        model = modelFromSpec(ctx, spec);
        origin = `OMP 插件设置：${spec}`;
        if (!model) return { ok: false, reason: `找不到 OMP 插件设置里的起草模型 ${spec}；可以填 provider/id、@角色、current 或 off` };
    } else if (choice.mode === "off") {
        return { ok: false, reason: "配置为不使用起草模型；可以在 /casepick config 里修改" };
    } else if (choice.mode === "follow_current") {
        // 默认：OMP 里给 casepick 角色指派了模型就用它，否则跟随当前会话的模型。
        model = roleModel(ctx);
        if (model) origin = `OMP 角色 @${modelRole}`;
        else model = ctx.model as Model<Api> | undefined;
        if (!model) return { ok: false, reason: "当前会话没有选定模型；请先选择模型，或在 /casepick config 里固定一个起草模型" };
    } else {
        model = ctx.modelRegistry.getAvailable().find((item) => item.provider === choice.provider && item.id === choice.id)
            ?? ctx.modelRegistry.find(choice.provider, choice.id);
        if (!model) return { ok: false, reason: `找不到配置的起草模型 ${choice.provider}/${choice.id}；请在 /casepick config 里重新选择` };
    }
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { ok: false, reason: `${modelName(model)} 没有可用的凭据，请先在宿主里配置` };
    const reasoning = resolveReasoning(model, overrides.reasoning ?? config.drafting.reasoning);
    return {
        ok: true,
        value: {
            model, key: modelKey(model), reasoning: reasoning.level, note: reasoning.note,
            maxOutputTokens: overrides.maxOutputTokens ?? config.drafting.max_output_tokens,
            timeoutSeconds: overrides.timeoutSeconds ?? config.drafting.timeout_s,
            label: `${modelName(model)} · ${reasoning.level ?? "不使用思考等级"}${origin ? `（${origin}）` : ""}`,
        },
    };
}

export interface PreparedRequest {
    prompt: Prompt;
    hits: RedactionHit[];
    chars: number;
}

export function prepareRequests(prompts: readonly Prompt[]): PreparedRequest[] {
    return prompts.map((prompt) => {
        const system = redact(prompt.system);
        const user = redact(prompt.user);
        const hits = new Map<string, number>();
        for (const hit of [...system.hits, ...user.hits]) hits.set(hit.kind, (hits.get(hit.kind) ?? 0) + hit.count);
        return {
            prompt: { system: system.text, user: user.text },
            hits: [...hits].map(([kind, count]) => ({ kind, count })),
            chars: system.text.length + user.text.length,
        };
    });
}

// 第一次向某个模型发送前展示完整示例请求；之后每批一行确认，完整内容可以展开查看。
export async function confirmSend(ctx: ExtensionCommandContext, config: Config, draft: DraftModel, requests: readonly PreparedRequest[], purpose: string): Promise<boolean> {
    const chars = requests.reduce((sum, request) => sum + request.chars, 0);
    const hits = new Map<string, number>();
    for (const request of requests) for (const hit of request.hits) hits.set(hit.kind, (hits.get(hit.kind) ?? 0) + hit.count);
    const redaction = hits.size ? `；已脱敏 ${[...hits].map(([kind, count]) => `${kind}×${count}`).join("、")}` : "";
    const oauth = (ctx.modelRegistry as { isUsingOAuth?: (model: Model<Api>) => boolean }).isUsingOAuth?.(draft.model)
        ? "\n该模型通过登录订阅使用，起草会占用同一份额度。" : "";
    const summary = `${purpose}：将用 ${draft.label} 发送 ${requests.length} 个请求，约 ${Math.ceil(chars / 1000)}k 字符${redaction}。${draft.note ? `\n${draft.note}。` : ""}${oauth}\n发出的请求可能被服务方计费；取消只能停止尚未发出的请求。`;
    const render = (request: PreparedRequest) => `【系统提示】\n${request.prompt.system}\n\n【消息】\n${request.prompt.user}`;
    if (!config.drafting.consented.includes(draft.key)) {
        await showText(ctx.ui, `第一次向 ${draft.label} 发送：完整示例请求`, render(requests[0]));
        if (!await ctx.ui.confirm("同意外发", `${summary}\n\n确认后，之后向这个模型发送时只需一行确认。`)) return false;
        config.drafting.consented.push(draft.key);
        await saveConfig(config);
        return true;
    }
    while (true) {
        const choice = await ctx.ui.select(summary, ["发送", "查看完整请求", "取消"]);
        if (choice === "发送") return true;
        if (choice !== "查看完整请求") return false;
        for (const [index, request] of requests.entries()) await showText(ctx.ui, `请求 ${index + 1} / ${requests.length}`, render(request));
    }
}

type CompleteSimple = (model: Model<Api>, context: Context, options?: Record<string, unknown>) => Promise<AssistantMessage>;

// OMP 从包根导出 completeSimple；Pi 1.1.0 放在 /compat 子路径。
async function loadCompleteSimple(): Promise<CompleteSimple> {
    const root = await import("@earendil-works/pi-ai") as { completeSimple?: CompleteSimple };
    if (typeof root.completeSimple === "function") return root.completeSimple;
    const compat = await import("@earendil-works/pi-ai/compat") as { completeSimple?: CompleteSimple };
    if (typeof compat.completeSimple === "function") return compat.completeSimple;
    throw new Error("宿主没有提供 completeSimple，无法调用起草模型");
}

export interface ModelReply {
    text: string;
    usage?: { input: number; output: number };
}

export async function callModel(ctx: ExtensionCommandContext, draft: DraftModel, prompt: Prompt, signal?: AbortSignal): Promise<ModelReply> {
    const context: Context = { systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }] };
    const timeout = AbortSignal.timeout(draft.timeoutSeconds * 1000);
    const options = {
        maxTokens: draft.maxOutputTokens,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
    };
    const registry = ctx.modelRegistry as unknown as {
        streamSimple?: (model: Model<Api>, context: Context, options?: object) => { result(): Promise<AssistantMessage> };
        getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error?: string }>;
    };
    let reply: AssistantMessage;
    if (typeof registry.streamSimple === "function") {
        // Pi：注册表在请求时处理认证、baseUrl 和环境变量。
        reply = await registry.streamSimple(draft.model, context, options).result();
    } else {
        const auth = await registry.getApiKeyAndHeaders(draft.model);
        if (!auth.ok) throw new Error(`无法取得 ${draft.label} 的凭据${"error" in auth && auth.error ? `：${auth.error}` : ""}`);
        const completeSimple = await loadCompleteSimple();
        reply = await completeSimple(draft.model, context, { ...options, apiKey: auth.apiKey, headers: auth.headers });
    }
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        throw new Error(reply.errorMessage || (reply.stopReason === "aborted" ? "请求已取消或超时" : "模型返回错误"));
    }
    const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    const usage = reply.usage ? { input: reply.usage.input, output: reply.usage.output } : undefined;
    await recordUsage({ at: new Date().toISOString(), model: draft.key, reasoning: draft.reasoning ?? null, purpose: "draft", input: usage?.input ?? null, output: usage?.output ?? null });
    return { text, usage };
}

// 只记录用量和模型，不记录内容和凭据。
async function recordUsage(record: Record<string, unknown>): Promise<void> {
    try {
        await appendLine(join(dataDir(), "usage.jsonl"), record, "用量记录");
    } catch {
        // 用量记录失败不影响起草结果。
    }
}
