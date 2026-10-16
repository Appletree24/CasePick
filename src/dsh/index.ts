import type { Context } from "@deepseek-ai/cordis";
import { readFileSync } from "node:fs";
import type {} from "@deepseek-ai/dsh-commands";
import { RpcId, type ConnectionRpcResult, type ServerResponse } from "@deepseek-ai/dsh-client-connection";
import type {} from "@deepseek-ai/dsh-settings";
import type {} from "@deepseek-ai/dsh-config-editor";
import type { Agent } from "@deepseek-ai/dsh-agent";
import Schema from "@deepseek-ai/schemastery";
import { parseCommand, helpText } from "../command.ts";
import { reasoningLevels } from "../core/reasoning.ts";
import type { WorkflowContext } from "../host.ts";
import { configure } from "../pi/config-ui.ts";
import { generateCases } from "../pi/generate.ts";
import { manageIssues } from "../pi/issues-ui.ts";
import { parseOverrides } from "../pi/plugin-settings.ts";
import { loadConfig } from "../store/config.ts";
import { loadCases } from "../store/cases.ts";
import { loadIssues } from "../store/issues.ts";
import { createDshModels } from "./models.ts";
import { captureDshSession, createDshHistorySources, createDshSources, listDshWorkspaceSessions, nativeSessionId, type CapturedDshSession } from "./sessions.ts";
import { rpcPath } from "./protocol.ts";
import type { NativeSettings, WorkspaceLibrary, WorkspaceLibraryDetail } from "./protocol.ts";
import { parseSettingsPatch } from "./settings-patch.ts";
import { DialogBridge } from "./ui-bridge.ts";

export const name = "casepick";
export const inject = ["commands", "connection", "agents", "sessions", "sessionQuery", "sessionProjections", "agentDefaultModel", "llm", "settings", "configEditor"];
export const Config = Schema.object({
    debug: Schema.boolean().default(false).description("查看请求、原始回复、解析及核对诊断，仅本次界面展示"),
    draftModel: Schema.string().default("").description("留空沿用 CasePick 配置；current、off 或 provider/model"),
    reasoning: Schema.union(["", ...reasoningLevels]).default("").description("留空沿用 CasePick 思考等级"),
    maxOutputTokens: Schema.union([Schema.const(null), Schema.number().min(256).max(200_000).step(1)]).default(null),
    timeoutSeconds: Schema.union([Schema.const(null), Schema.number().min(10).max(3600).step(1)]).default(null),
}).volatile();

export interface NativePluginConfig {
    get(): NativeSettings;
}

function objectPayload(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("请求必须是对象");
    return value as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, key: string): string {
    const value = payload[key];
    if (typeof value !== "string" || !value.trim()) throw new TypeError(`缺少 ${key}`);
    return value;
}

export function apply(ctx: Context, config: NativePluginConfig): void {
    ctx.effect(() => ctx.settings.configure({ auto: false }));
    const settings = {
        get: (): NativeSettings => config.get(),
        update: async (patch: Partial<NativeSettings>): Promise<void> => {
            const entry = ctx.configEditor.entries().find((entry) => entry.fiber === ctx.fiber);
            if (!entry) throw new Error("找不到 CasePick 的 DSH 配置条目");
            await ctx.settings.update(entry.options.id, patch);
        },
    };
    const views = new Map<string, DialogBridge>();
    const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
    const bridgeFor = (id: string) => {
        let bridge = views.get(id);
        if (!bridge) { bridge = new DialogBridge(id); views.set(id, bridge); }
        return bridge;
    };

    async function execute(source: Agent | CapturedDshSession, args: string, ui: WorkflowContext["ui"], signal: AbortSignal, cutoffEntry?: string): Promise<void> {
        const parsed = args.trim() === "issues" ? { kind: "run" as const, action: "issues" as const } : parseCommand(args);
        if (parsed.kind === "help") { ui.notify(helpText(parsed.topic), "info"); return; }
        if (parsed.kind === "error") { ui.notify(parsed.message, "error"); return; }
        if (parsed.action !== "scan" && parsed.action !== "config" && parsed.action !== "issues") {
            ui.notify("这个命令尚未实现；本次未读取会话、调用模型或保存案例。", "warning");
            return;
        }
        ui.setStatus("casepick", "CasePick：正在读取宿主模型配置…");
        const local = await loadConfig();
        const specs = [settings.get().draftModel];
        if (local.drafting.model.mode === "fixed") specs.push(`${local.drafting.model.provider}/${local.drafting.model.id}`);
        const models = await createDshModels(ctx, source, signal, specs);
        signal.throwIfAborted();
        const liveAgent = "session" in source ? source : undefined;
        const workflow: WorkflowContext = {
            cwd: ("session" in source ? source.session.header.cwd : source.header.cwd) ?? process.cwd(), hasUI: true,
            isIdle: () => (!liveAgent || liveAgent.status === "idle") && !signal.aborted, ui,
            modelRegistry: models.modelRegistry, hostName: "DSH",
            get model() { return models.model; },
            sources: "session" in source ? createDshSources(ctx, source, signal) : createDshHistorySources(ctx, source, signal),
            pluginSettings: async () => ({ ...parseOverrides(settings.get()), available: true, source: "DSH 左侧栏 → CasePick" }),
        };
        for (const warning of models.warnings ?? []) ui.notify(warning, "warning");
        ui.setStatus("casepick", undefined);
        if (parsed.action === "config") await configure(workflow);
        else if (parsed.action === "issues") await manageIssues({}, workflow, version, await workflow.sources!.readCurrent());
        else await generateCases({}, workflow, version, cutoffEntry);
    }

    ctx.commands.register({
        name: "casepick", description: "把会话中的犯错整理成评测案例", input: { hint: "[config|help]" }, recordInput: false,
        handler: ({ agent, rawInput }) => {
            bridgeFor(agent.id).startMaintenance(agent, (ui, signal) => execute(agent, rawInput, ui, signal));
            return { kind: "success", text: "CasePick 已在当前会话的插件面板打开。" };
        },
    });

    async function dispatch(input: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<unknown>> {
        try {
            const request = objectPayload(input);
            const endpoint = stringField(request, "endpoint");
            const payload = objectPayload(request.payload);
            if (endpoint === "settings") return { ok: true, value: settings.get() };
            if (endpoint === "settings/update") {
                await settings.update(parseSettingsPatch(payload));
                return { ok: true, value: settings.get() };
            }
            if (endpoint === "sessions/list") return { ok: true, value: await listDshWorkspaceSessions(ctx, signal) };
            if (endpoint === "sessions/read") {
                const captured = await captureDshSession(ctx, stringField(payload, "sessionId"), signal);
                return { ok: true, value: captured.workspace };
            }
            if (endpoint === "library") {
                const [cases, issues] = await Promise.all([loadCases(), loadIssues()]);
                const library: WorkspaceLibrary = {
                    cases: cases.map((doc) => ({ id: doc.id, title: doc.title, createdAt: doc.provenance.created_at })),
                    issues: issues.map((issue) => ({
                        id: issue.id, title: issue.title, sessionCount: issue.sessions.length,
                        evidenceCount: issue.evidence.length, sliceCount: issue.slices.length,
                    })),
                };
                return { ok: true, value: library };
            }
            if (endpoint === "library/read") {
                const kind = payload.kind;
                if (kind !== "case" && kind !== "issue") throw new TypeError("kind 必须是 case 或 issue");
                const id = stringField(payload, "id");
                const documents = kind === "case" ? await loadCases() : await loadIssues();
                const document = documents.find((item) => item.id === id);
                if (!document) throw new Error("记录不存在，请刷新案例库");
                const detail: WorkspaceLibraryDetail = { id: document.id, title: document.title, content: JSON.stringify(document, null, 2) };
                return { ok: true, value: detail };
            }
            const sessionId = nativeSessionId(stringField(payload, "sessionId"));
            const bridge = bridgeFor(sessionId);
            if (endpoint === "state") {
                const revision = payload.revision;
                if (revision !== undefined && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) throw new TypeError("revision 无效");
                return { ok: true, value: await bridge.wait(revision as number | undefined, signal) };
            }
            if (endpoint === "start") {
                const args = payload.args;
                const cutoffEntry = payload.cutoffEntry;
                if (args !== undefined && typeof args !== "string") throw new TypeError("args 必须是文字");
                if (cutoffEntry !== undefined && (typeof cutoffEntry !== "string" || !/^dsh:\d+$/.test(cutoffEntry))) throw new TypeError("cutoffEntry 必须是原生消息 ID");
                const watermark = payload.watermark;
                if (watermark !== undefined && (typeof watermark !== "number" || !Number.isSafeInteger(watermark) || watermark < -1)) throw new TypeError("watermark 必须是有效的原生快照截止位置");
                if (cutoffEntry !== undefined && watermark === undefined) throw new TypeError("审阅指定回复必须提供所显示快照的 watermark");
                return {
                    ok: true,
                    value: bridge.start(async (ui, operationSignal) => {
                        const captured = await captureDshSession(ctx, sessionId, operationSignal, watermark);
                        operationSignal.throwIfAborted();
                        await execute(captured, args ?? "", ui, operationSignal, cutoffEntry);
                    }),
                };
            }
            const runId = stringField(payload, "runId");
            if (endpoint === "answer") return { ok: true, value: bridge.answer(runId, stringField(payload, "dialogId"), payload.value) };
            if (endpoint === "cancel") return { ok: true, value: bridge.cancel(runId) };
            throw new Error(`未知 CasePick 操作 ${endpoint}`);
        } catch (error) {
            return { ok: false, error: { code: "casepick_error", message: error instanceof Error ? error.message : String(error), details: {} } };
        }
    }
    // An exact authenticated Fetch route coexists with the gateway's sole /api
    // interceptor. CasePick exchanges JSON using Connection's public envelopes.
    ctx.effect(() => ctx.connection.fetch.register({
        path: `${rpcPath}/casepick`,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
            let input: Record<string, unknown>;
            try {
                input = objectPayload(await request.json());
                if (input.type !== "client-request" || input.method !== "casepick") throw new TypeError("无效的 RPC 请求");
                stringField(input, "rpcId");
            } catch {
                return new Response("无效的 RPC 请求", { status: 400 });
            }
            const response: ServerResponse = {
                type: "server-response",
                rpcId: RpcId(stringField(input, "rpcId")),
                result: await dispatch(input.payload, request.signal),
            };
            return Response.json(response);
        },
    }));
    ctx.effect(() => () => {
        for (const bridge of views.values()) bridge.dispose();
        views.clear();
    });
}
