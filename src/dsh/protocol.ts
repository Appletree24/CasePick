// DSH 已认证、以本地 operator 身份调用的 Connection RPC；不绑定浏览器会话，不含模型凭据。
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

export type NativeSettings = {
    debug: boolean;
    draftModel: string;
    reasoning: ReasoningLevel | "";
    maxOutputTokens?: number | null;
    timeoutSeconds?: number | null;
};

export interface WorkspaceSession {
    id: string;
    title: string;
    cwd: string;
    createdAt: number;
}

export interface WorkspaceEntry {
    id: string;
    role: string;
    content: string;
    at?: string;
    toolCalls?: { id: string; name: string; arguments: string }[];
}

export interface WorkspaceSnapshot {
    session: WorkspaceSession;
    watermark: number;
    entries: WorkspaceEntry[];
}

export interface WorkspaceLibrary {
    cases: { id: string; title: string; createdAt: string }[];
    issues: { id: string; title: string; sessionCount: number; evidenceCount: number; sliceCount: number }[];
}

export interface WorkspaceLibraryDetail {
    id: string;
    title: string;
    content: string;
}

// endpoints:
// start { sessionId, args?: string, cutoffEntry?: string, watermark?: number } -> ViewState
// watermark binds an immutable native event prefix; required for cutoffEntry.
// state { sessionId, revision?: number } -> ViewState (long-poll, at most 20s)
// answer { sessionId, runId, dialogId, value: string | boolean | null } -> ViewState
// cancel { sessionId, runId } -> ViewState (abort; closes pending dialog)
// settings {} -> NativeSettings
// settings/update Partial<NativeSettings> -> NativeSettings (unknown keys or invalid values reject the whole patch;
//   null maxOutputTokens/timeoutSeconds and "" draftModel/reasoning fall back to /casepick config)
// sessions/list {} -> WorkspaceSession[]
// sessions/read { sessionId } -> WorkspaceSnapshot (detached native read-only cut)
// library {} -> WorkspaceLibrary
// library/read { kind: "case" | "issue", id: string } -> WorkspaceLibraryDetail
