import type { Context } from "@deepseek-ai/cordis";
import { readFileSync } from "node:fs";
import type {} from "@deepseek-ai/dsh-commands";
import { clientRequestSchema, serverResponseSchema } from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-settings";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { SessionId } from "@deepseek-ai/dsh-session";
import Schema from "@deepseek-ai/schemastery";
import { parseCommand, helpText } from "../command.ts";
import { reasoningLevels } from "../core/reasoning.ts";
import type { WorkflowContext } from "../host.ts";
import { configure } from "../pi/config-ui.ts";
import { generateCases } from "../pi/generate.ts";
import { parseOverrides } from "../pi/plugin-settings.ts";
import { loadConfig } from "../store/config.ts";
import { createDshModels } from "./models.ts";
import { createDshSources } from "./sessions.ts";
import { rpcPath } from "./protocol.ts";
import type { NativeSettings } from "./protocol.ts";
import { DialogBridge } from "./ui-bridge.ts";

export const name = "casepick";
export const inject = ["commands", "connection", "agents", "sessionQuery", "sessionProjections", "agentDefaultModel", "llm", "settings"];
export const Config = Schema.object({
    debug: Schema.boolean().default(false).description("查看请求、原始回复、解析及核对诊断，仅本次界面展示"),
    draftModel: Schema.string().default("").description("留空沿用 CasePick 配置；current、off 或 provider/model"),
    reasoning: Schema.union(["", ...reasoningLevels]).default("").description("留空沿用 CasePick 思考等级"),
    maxOutputTokens: Schema.union([Schema.const(null), Schema.number().min(256).max(200_000).step(1)]).default(null),
    timeoutSeconds: Schema.union([Schema.const(null), Schema.number().min(10).max(3600).step(1)]).default(null),
});

function objectPayload(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("请求必须是对象");
    return value as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`缺少 ${key}`);
    return value;
}

export function apply(ctx: Context, config: NativeSettings): void {
    const settings = ctx.settings.register("casepick", Config, { base: config });
    const views = new Map<string, DialogBridge>();
    const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    const bridgeFor = (id: string) => {
        let bridge = views.get(id);
        if (!bridge) { bridge = new DialogBridge(id); views.set(id, bridge); }
        return bridge;
    };

    async function execute(agent: Agent, args: string, ui: WorkflowContext["ui"], signal: AbortSignal): Promise<void> {
        const parsed = parseCommand(args);
        if (parsed.kind === "help") { ui.notify(helpText(parsed.topic), "info"); return; }
        if (parsed.kind === "error") { ui.notify(parsed.message, "error"); return; }
        if (parsed.action !== "scan" && parsed.action !== "config") {
            ui.notify("这个命令尚未实现；本次未读取会话、调用模型或保存案例。", "warning");
            return;
        }
        ui.setStatus("casepick", "CasePick：正在读取宿主模型配置…");
        const local = await loadConfig();
        const specs = [settings.get().draftModel];
        if (local.drafting.model.mode === "fixed") specs.push(`${local.drafting.model.provider}/${local.drafting.model.id}`);
        const models = await createDshModels(ctx, agent, signal, specs);
        signal.throwIfAborted();
        const workflow: WorkflowContext = {
            cwd: agent.session.header.cwd ?? process.cwd(), hasUI: true,
            isIdle: () => agent.status === "idle", ui,
            modelRegistry: models.modelRegistry, hostName: "DSH",
            get model() { return models.model; },
            sources: createDshSources(ctx, agent, signal),
            pluginSettings: async () => ({ ...parseOverrides(settings.get()), available: true, source: "DSH Settings → Plugins → CasePick" }),
        };
        for (const warning of models.warnings ?? []) ui.notify(warning, "warning");
        ui.setStatus("casepick", undefined);
        if (parsed.action === "config") await configure(workflow);
        else await generateCases({}, workflow, version);
    }

    function start(agent: Agent, args: string) {
        const bridge = bridgeFor(agent.id);
        const run = bridge.begin();
        if (run) {
            const detach = agent.ctx.effect(() => () => {
                const view = bridge.snapshot();
                if (view.runId === run.id && !view.done) bridge.cancel(run.id);
            });
            void execute(agent, args, run.ui, run.signal).then(
                () => bridge.finish(run.id),
                (error: unknown) => bridge.finish(run.id, error),
            ).finally(detach);
        }
        return bridge.snapshot();
    }

    ctx.commands.register({
        name: "casepick", description: "把会话中的犯错整理成评测案例", input: { hint: "[config|help]" }, recordInput: false,
        handler: ({ agent, rawInput }) => {
            start(agent, rawInput);
            return { kind: "success", text: "CasePick 已在当前会话的插件面板打开。" };
        },
    });

    async function dispatch(input: unknown, signal: AbortSignal) {
        try {
            const request = objectPayload(input);
            const endpoint = stringField(request, "endpoint");
            const payload = objectPayload(request.payload);
            if (endpoint === "settings") return { ok: true, value: settings.get() };
            if (endpoint === "settings/update") {
                if (typeof payload.debug !== "boolean") throw new TypeError("debug 必须是布尔值");
                await settings.update({ debug: payload.debug });
                return { ok: true, value: settings.get() };
            }
            const sessionId = stringField(payload, "sessionId");
            const bridge = bridgeFor(sessionId);
            if (endpoint === "state") {
                const revision = payload.revision;
                if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) throw new TypeError("revision 无效");
                return { ok: true, value: await bridge.wait(revision as number | undefined, signal) };
            }
            if (endpoint === "start") {
                const agent = ctx.agents.get(SessionId(sessionId));
                if (!agent) throw new Error("当前会话没有活动 Agent，请先在 DSH 中打开该会话");
                if (payload.args !== undefined && typeof payload.args !== "string") throw new TypeError("args 必须是文字");
                return { ok: true, value: start(agent, payload.args as string | undefined ?? "") };
            }
            const runId = stringField(payload, "runId");
            if (endpoint === "answer") return { ok: true, value: bridge.answer(runId, stringField(payload, "dialogId"), payload.value) };
            if (endpoint === "cancel") return { ok: true, value: bridge.cancel(runId) };
            throw new Error(`未知 CasePick 操作 ${endpoint}`);
        } catch (error) {
            return { ok: false, error: { code: "casepick_error", message: error instanceof Error ? error.message : String(error), details: {} } };
        }
    }
    // Use Connection's authenticated shared carrier and its native envelope schemas.
    // Standalone rpc.handle() in DSH 0.1.5-rc.2 loses the caller's webServer scope.
    ctx.effect(() => ctx.connection.fetch.register({
        path: `${rpcPath}/casepick`,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
            const envelope = clientRequestSchema.safeParse(await request.json().catch(() => undefined));
            if (!envelope.success || envelope.data.method !== "casepick") return new Response("invalid CasePick RPC request", { status: 400 });
            const result = await dispatch(envelope.data.payload, request.signal);
            return Response.json(serverResponseSchema.parse({ type: "server-response", rpcId: envelope.data.rpcId, result }));
        },
    }));
    ctx.effect(() => () => {
        for (const bridge of views.values()) bridge.dispose();
        views.clear();
    });
}
