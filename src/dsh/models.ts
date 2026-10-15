import type { Context as DshContext } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { BlockAssembler, createUserMessage, ReasoningEffortId, type LlmResolvedModelInfo } from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-session-projection";
import type {} from "@deepseek-ai/dsh-api-session-controller/types";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { WorkflowModelRegistry } from "../host.ts";

// These are the shared UI's exact vocabulary, not aliases for native opaque effort IDs.
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function currentSelection(ctx: DshContext, agent: Agent) {
    const state = ctx.sessionProjections.stateOf(agent.session, "modelSelection");
    if (!state) throw new Error("DSH 缺少 modelSelection 投影，无法确定当前模型");
    // Browser model choice is pending -> last used -> host default. Agent.options
    // can retain the bootstrap default after a historical Session is reopened.
    return state.pending ?? state.lastUsed ?? ctx.agentDefaultModel.currentSelection();
}

export async function createDshModels(ctx: DshContext, agent: Agent, signal: AbortSignal, requestedSpecs: readonly string[] = []): Promise<{ model?: Model<Api>; modelRegistry: WorkflowModelRegistry; warnings?: string[] }> {
    signal.throwIfAborted();
    const nativeModels = new Map<string, LlmResolvedModelInfo>();
    const models = new Map<string, Model<Api>>();
    const warnings: string[] = [];
    const providers = ctx.llm.listProviders();
    const current = currentSelection(ctx, agent);
    const currentKey = `${current.provider}/${current.model}`;
    const requested = new Set(requestedSpecs.filter((spec) => spec !== "current" && spec !== "off"));
    requested.add(currentKey);
    for (const provider of providers) {
        signal.throwIfAborted();
        try {
            for (const model of await ctx.llm.listModels(provider.id)) requested.add(`${model.provider}/${model.id}`);
        } catch (error) {
            signal.throwIfAborted();
            warnings.push(`DSH 无法列出 ${provider.id} 模型：${error instanceof Error ? error.message : String(error)}`);
        }
    }
    for (const spec of requested) {
        signal.throwIfAborted();
        const slash = spec.indexOf("/");
        if (slash <= 0 || slash === spec.length - 1) continue;
        const provider = spec.slice(0, slash);
        const id = spec.slice(slash + 1);
        let info: LlmResolvedModelInfo;
        try {
            info = await ctx.llm.resolveModelInfo(provider, id, signal);
        } catch (error) {
            signal.throwIfAborted();
            warnings.push(`DSH 无法解析模型 ${spec}：${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        signal.throwIfAborted();
        nativeModels.set(spec, info);
        const efforts = new Set(info.reasoning?.efforts.map((effort) => String(effort.id)) ?? []);
        // Portable UI consumes identity/capabilities only. Native routes have no Pi baseUrl,
        // cost, or mandatory capacity metadata: leave unavailable values absent, not invented.
        models.set(spec, {
            provider: info.provider, id: info.id, name: info.name, api: "dsh-native",
            input: info.inputModalities?.filter((modality): modality is "text" | "image" => modality === "text" || modality === "image"),
            reasoning: levels.some((level) => level !== "off" && efforts.has(level)),
            thinkingLevelMap: Object.fromEntries(levels.map((level) => [level, efforts.has(level) ? level : null])),
            ...(info.context ? { contextWindow: info.context.contextWindow } : {}),
            ...(info.defaultMaxTokens === undefined ? {} : { maxTokens: info.defaultMaxTokens }),
        } as Model<Api>);
    }
    const modelRegistry: WorkflowModelRegistry = {
        getAvailable: () => [...models.values()],
        find: (provider, id) => models.get(`${provider}/${id}`),
        // DSH owns authentication at dispatch. No credential probe/copy or ambient-key inference.
        hasConfiguredAuth: (model) => nativeModels.has(`${model.provider}/${model.id}`),
        streamSimple(model, context, options = {}) {
            return { result: () => run(model, context, options) };
        },
    };
    async function run(model: Model<Api>, context: Context, options: object): Promise<AssistantMessage> {
        const info = nativeModels.get(`${model.provider}/${model.id}`);
        if (!info) throw new Error(`DSH 模型尚未解析：${model.provider}/${model.id}`);
        const opts = options as Record<string, unknown>;
        for (const key of Object.keys(opts)) {
            if (!["signal", "reasoning", "maxTokens", "temperature", "timeoutMs"].includes(key)) throw new Error(`DSH 不支持起草参数 ${key}`);
        }
        if (opts.signal !== undefined && !(opts.signal instanceof AbortSignal)) throw new Error("DSH signal 必须是 AbortSignal");
        if (opts.maxTokens !== undefined && (typeof opts.maxTokens !== "number" || !Number.isSafeInteger(opts.maxTokens) || opts.maxTokens <= 0)) throw new Error("DSH maxTokens 必须是正整数");
        if (opts.temperature !== undefined && (typeof opts.temperature !== "number" || !Number.isFinite(opts.temperature))) throw new Error("DSH temperature 必须是有限数值");
        if (opts.timeoutMs !== undefined && (typeof opts.timeoutMs !== "number" || !Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 0)) throw new Error("DSH timeoutMs 必须是非负整数");
        if (opts.reasoning !== undefined && (typeof opts.reasoning !== "string" || !info.reasoning?.efforts.some((effort) => effort.id === opts.reasoning))) {
            throw new Error(`DSH 模型 ${model.provider}/${model.id} 不支持思考等级 ${String(opts.reasoning)}`);
        }
        if (context.tools?.length) throw new Error("DSH 案例起草不支持工具");
        const messages = context.messages.map((message) => {
            if (message.role !== "user" || typeof message.content !== "string") throw new Error("DSH 案例起草只接受独立的纯文本 user 请求");
            return createUserMessage({ content: [{ type: "text", text: message.content }], source: { kind: "plugin", plugin: "casepick" } });
        });
        const signals = [signal];
        if (opts.signal instanceof AbortSignal) signals.push(opts.signal);
        if (typeof opts.timeoutMs === "number") signals.push(AbortSignal.timeout(opts.timeoutMs));
        const operation = AbortSignal.any(signals);
        operation.throwIfAborted();
        const prepared = await ctx.llm.prepareCall({
            provider: info.provider, model: info.id,
            ...(opts.reasoning === undefined ? {} : { reasoningEffort: ReasoningEffortId(opts.reasoning as string) }),
            ...(opts.maxTokens === undefined ? {} : { maxTokens: opts.maxTokens as number }),
            ...(opts.temperature === undefined ? {} : { temperature: opts.temperature as number }),
        }, operation);
        operation.throwIfAborted();
        const assembler = new BlockAssembler();
        let terminal = false;
        const timestamp = Date.now();
        // Fresh message identities, prepared handle, and assembler per call; never stamp the
        // conversation's sessionId, pass its tools/history, or append anything to its log.
        for await (const chunk of prepared.stream({ ...prepared.config, system: context.systemPrompt, messages, signal: operation })) {
            operation.throwIfAborted();
            assembler.push(chunk);
            if (chunk.type === "finish") terminal = true;
        }
        operation.throwIfAborted();
        if (!terminal) throw new Error("DSH 模型流未返回终止状态，拒绝使用未完成输出");
        const finish = assembler.finish;
        if (finish.kind === "error" || finish.kind === "aborted") throw new Error(`${finish.failure.code}: ${finish.failure.message}`);
        if (finish.kind !== "stop" && finish.kind !== "max-tokens") throw new Error(`DSH 案例起草返回了不支持的终止状态 ${finish.kind}`);
        const blocks = assembler.blocks();
        if (blocks.some((block) => block.type !== "text" && block.type !== "reasoning")) throw new Error("DSH 案例起草返回非文本内容");
        const usage = assembler.usage;
        const input = usage ? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) : undefined;
        // Pi's required usage/pricing fields are not native facts. At this one portable
        // boundary preserve only observed counts; shared callModel treats missing usage as unknown.
        return {
            role: "assistant", api: "dsh-native", provider: info.provider, model: info.id,
            content: blocks.filter((block) => block.type === "text"),
            stopReason: finish.kind === "max-tokens" ? "length" : "stop", timestamp,
            ...(usage ? { usage: { input, output: usage.outputTokens,
                ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
                ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
                ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
                ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
            } } : {}),
        } as unknown as AssistantMessage;
    }
    signal.throwIfAborted();
    return {
        get model() {
            const current = currentSelection(ctx, agent);
            return models.get(`${current.provider}/${current.model}`);
        },
        modelRegistry, ...(warnings.length ? { warnings } : {}),
    };
}
