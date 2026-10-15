// DSH 已认证 Connection RPC 上的 CasePick 界面协议；不含模型凭据。
import type { ReasoningLevel } from "../core/reasoning.ts";
export const rpcPath = "/api";

export interface Dialog {
    id: string;
    kind: "select" | "confirm" | "editor";
    title: string;
    options?: string[];
    message?: string;
    prefill?: string;
}

export interface Notice {
    text: string;
    level: "info" | "warning" | "error";
}

export interface ViewState {
    sessionId: string;
    revision: number;
    runId?: string;
    dialog?: Dialog;
    notices: Notice[];
    status: Record<string, string>;
    done: boolean;
}

export interface NativeSettings {
    debug: boolean;
    draftModel: string;
    reasoning: ReasoningLevel | "";
    maxOutputTokens: number | null;
    timeoutSeconds: number | null;
}

// endpoints:
// start { sessionId, args?: string } -> ViewState
// state { sessionId, revision?: number } -> ViewState (long-poll, at most 20s)
// answer { sessionId, runId, dialogId, value: string | boolean | null } -> ViewState
// cancel { sessionId, runId } -> ViewState (abort; closes pending dialog)
// settings {} -> NativeSettings
// settings/update { debug: boolean } -> NativeSettings
