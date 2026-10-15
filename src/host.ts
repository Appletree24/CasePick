// 各宿主只适配会话、交互与模型调用；案例整理逻辑共用。
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { LoadedSession, SessionChoice } from "./pi/sources.ts";
import type { SessionSnapshot } from "./pi/read-session.ts";
import type { PluginSettingsResult } from "./pi/plugin-settings.ts";

export type WorkflowUI = Pick<ExtensionUIContext, "select" | "confirm" | "editor" | "notify" | "setStatus">;
export type WorkflowAPI = Partial<Pick<ExtensionAPI, "getActiveTools" | "getAllTools">>;
export type PiSessionSDK = Pick<typeof import("@earendil-works/pi-coding-agent"), "SessionManager" | "buildSessionContext" | "convertToLlm" | "VERSION">;

export interface WorkflowModelRegistry extends Pick<ExtensionCommandContext["modelRegistry"], "getAvailable" | "find" | "hasConfiguredAuth"> {
    streamSimple?(model: Model<Api>, context: Context, options?: object): { result(): Promise<AssistantMessage> };
    getApiKeyAndHeaders?: ExtensionCommandContext["modelRegistry"]["getApiKeyAndHeaders"];
    isUsingOAuth?(model: Model<Api>): boolean;
}

export interface SessionSource {
    readCurrent(): Promise<SessionSnapshot>;
    current(snapshot: SessionSnapshot): LoadedSession;
    list(): Promise<SessionChoice[]>;
    load(location: string): Promise<LoadedSession>;
}

export interface WorkflowContext {
    cwd: string;
    hasUI: boolean;
    isIdle(): boolean;
    ui: WorkflowUI;
    model?: ExtensionCommandContext["model"];
    models?: { resolve(spec: string): Model<Api> | undefined };
    modelRegistry: WorkflowModelRegistry;
    // Pi/OMP 原生会话接口；其他宿主通过 sources 提供自己的恢复语义。
    sessionManager?: ExtensionCommandContext["sessionManager"];
    piSdk?: PiSessionSDK;
    sources?: SessionSource;
    hostName?: string;
    pluginSettings?(): Promise<PluginSettingsResult>;
}
