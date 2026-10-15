import * as React from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ClientConnectionRpc, ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-ui-commands/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings-plugins/client";
import type { UseSessions } from "@deepseek-ai/dsh-client-ui-session/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { rpcPath, type Dialog, type NativeSettings, type ViewState } from "./protocol.js";

export const name = "casepick";
export const inject = ["commandUi", "connection", "slots"];

type Rpc = ClientConnectionRpc;
type ClientContext = Context & { connection: ConnectionHandle };

async function call<T>(rpc: Rpc, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const result = await rpc.call(rpcPath, "casepick", { endpoint, payload }, signal);
    if (!result.ok) throw new Error(result.error.message);
    return result.value as T;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

interface SurfaceState {
    view?: ViewState;
    open: boolean;
    busy: boolean;
    error?: string;
}

/** One receiving session owns its polling, dialog identity, and cancellation. */
class SessionSurface {
    private state: SurfaceState = { open: false, busy: false };
    private readonly listeners = new Set<() => void>();
    private poll?: AbortController;
    private dismissedRun?: string;
    private mounts = 0;
    private disposed = false;
    private startSerial = 0;
    private pendingStart = false;

    constructor(private readonly rpc: Rpc, readonly sessionId: string) {}

    readonly getSnapshot = (): SurfaceState => this.state;
    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    private update(patch: Partial<SurfaceState>): void {
        if (this.disposed) return;
        this.state = { ...this.state, ...patch };
        for (const listener of this.listeners) listener();
    }

    private accept(view: ViewState): void {
        if (view.sessionId !== this.sessionId || this.disposed) return;
        const previous = this.state.view;
        if (previous && view.revision < previous.revision) return;
        const discover = view.runId !== undefined && view.runId !== this.dismissedRun;
        this.update({ view, open: this.state.open || discover, error: undefined });
    }

    attach(): () => void {
        this.mounts++;
        this.beginPolling();
        return () => {
            if (--this.mounts !== 0) return;
            this.poll?.abort();
            this.poll = undefined;
            this.close();
        };
    }

    private beginPolling(): void {
        if (this.poll || this.disposed) return;
        const controller = new AbortController();
        this.poll = controller;
        void this.pollState(controller);
    }

    private async pollState(controller: AbortController): Promise<void> {
        while (!controller.signal.aborted && !this.disposed) {
            try {
                const view = await call<ViewState>(this.rpc, "state", {
                    sessionId: this.sessionId,
                    revision: this.state.view?.revision,
                }, controller.signal);
                if (controller.signal.aborted) return;
                this.accept(view);
            } catch (error) {
                if (controller.signal.aborted || this.disposed) return;
                this.update({ error: errorMessage(error) });
                // The connection may be reconnecting; keep the session observer alive.
                const delay = Promise.withResolvers<void>();
                const finish = () => {
                    clearTimeout(timer);
                    controller.signal.removeEventListener("abort", finish);
                    delay.resolve();
                };
                const timer = setTimeout(finish, 1000);
                controller.signal.addEventListener("abort", finish, { once: true });
                await delay.promise;
            }
        }
    }

    readonly open = async (args = ""): Promise<void> => {
        if (this.disposed || this.pendingStart) return;
        const current = this.state.view;
        if (current?.runId && !current.done && current.runId !== this.dismissedRun) {
            this.update({ open: true });
            return;
        }
        const serial = ++this.startSerial;
        this.pendingStart = true;
        this.update({ open: true, busy: true, error: undefined });
        try {
            // Do not abort a start response: if the modal closes in flight, its
            // returned run still needs an explicit, identity-fenced cancellation.
            const view = await call<ViewState>(this.rpc, "start", { sessionId: this.sessionId, args });
            if (serial !== this.startSerial || this.disposed) {
                if (view.runId && !view.done) {
                    this.dismissedRun = view.runId;
                    await this.cancelRun(view.runId).catch((error: unknown) => {
                        this.update({ open: true, error: `Could not cancel CasePick: ${errorMessage(error)}` });
                    });
                }
                return;
            }
            this.dismissedRun = undefined;
            this.accept(view);
        } catch (error) {
            if (serial === this.startSerial) this.update({ error: errorMessage(error) });
        } finally {
            this.pendingStart = false;
            if (serial === this.startSerial) this.update({ busy: false });
        }
    };

    readonly answer = async (runId: string, dialogId: string, value: string | boolean | null): Promise<void> => {
        const current = this.state.view;
        if (this.state.busy || !this.state.open || current?.runId !== runId || current.dialog?.id !== dialogId) return;
        const serial = this.startSerial;
        this.update({ busy: true, error: undefined });
        try {
            const view = await call<ViewState>(this.rpc, "answer", { sessionId: this.sessionId, runId, dialogId, value });
            this.accept(view);
        } catch (error) {
            if (this.state.open && this.state.view?.runId === runId) this.update({ error: errorMessage(error) });
        } finally {
            if (serial === this.startSerial) this.update({ busy: false });
        }
    };

    private async cancelRun(runId: string): Promise<void> {
        const view = await call<ViewState>(this.rpc, "cancel", { sessionId: this.sessionId, runId });
        this.accept(view);
    }

    readonly close = (): void => {
        ++this.startSerial;
        const view = this.state.view;
        this.dismissedRun = view?.runId;
        this.update({ open: false, busy: false, error: undefined });
        if (view?.runId && !view.done) {
            void this.cancelRun(view.runId).catch((error: unknown) => {
                this.update({ open: true, error: `Could not cancel CasePick: ${errorMessage(error)}` });
            });
        }
    };

    dispose(): void {
        this.close();
        this.disposed = true;
        this.poll?.abort();
        this.listeners.clear();
    }
}

const buttonStyle: React.CSSProperties = {
    font: "inherit", color: "inherit", background: "transparent", border: "1px solid currentColor",
    borderRadius: 6, padding: "7px 12px", cursor: "pointer",
};
const stackStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 12, minWidth: 0 };
const rowStyle: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 };

function DialogForm({ dialog, busy, answer }: {
    dialog: Dialog;
    busy: boolean;
    answer: (value: string | boolean | null) => void;
}): React.ReactElement {
    const [text, setText] = React.useState(dialog.prefill ?? "");
    const form = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        if (!busy) form.current?.querySelector<HTMLElement>("[data-modal-autofocus]")?.focus();
    }, [dialog.id, busy]);
    return <div ref={form} style={stackStyle}>
        {dialog.message !== undefined && <p style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{dialog.message}</p>}
        {dialog.kind === "select" && <div style={{ ...stackStyle, gap: 6, maxHeight: "50vh", overflowY: "auto" }}>
            {(dialog.options ?? []).map((option, index) => <button
                key={index} type="button" disabled={busy} data-modal-autofocus={index === 0 ? "" : undefined}
                style={{ ...buttonStyle, textAlign: "left", whiteSpace: "pre-wrap", overflowWrap: "anywhere", flexShrink: 0 }}
                onClick={() => answer(option)}
            >{option}</button>)}
        </div>}
        {dialog.kind === "editor" && <>
            <textarea
                aria-label={dialog.title} data-modal-autofocus="" rows={10} value={text} disabled={busy}
                style={{ boxSizing: "border-box", width: "100%", minWidth: 0, maxHeight: "50vh", resize: "vertical", font: "inherit", color: "inherit", background: "transparent", border: "1px solid currentColor", borderRadius: 6, padding: 10 }}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if (!busy) answer(text);
                    }
                }}
            />
            <small>Enter to submit · Shift+Enter for a new line</small>
        </>}
        <div style={rowStyle}>
            {dialog.kind === "confirm" && <>
                <button type="button" data-modal-autofocus="" style={buttonStyle} disabled={busy} onClick={() => answer(true)}>Yes</button>
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => answer(false)}>No</button>
            </>}
            {dialog.kind === "editor" && <button type="button" style={buttonStyle} disabled={busy} onClick={() => answer(text)}>Submit</button>}
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => answer(null)}>Cancel</button>
        </div>
    </div>;
}

function SessionOverlay({ surface }: { surface: SessionSurface }): React.ReactElement {
    const state = React.useSyncExternalStore(surface.subscribe, surface.getSnapshot, surface.getSnapshot);
    React.useEffect(() => surface.attach(), [surface]);
    const view = state.view;
    const dialog = view?.dialog;
    return <Modal open={state.open} title="CasePick" closeLabel="Close CasePick" onClose={surface.close}>
        <div style={{ ...stackStyle, maxHeight: "70vh", overflowY: "auto" }}>
            {dialog && <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "35vh", overflowY: "auto", flexShrink: 0 }}>{dialog.title}</div>}
            {state.error && <div role="alert" style={{ color: "#d64545", whiteSpace: "pre-wrap" }}>{state.error}</div>}
            {view && Object.keys(view.status).length > 0 && <div role="status" aria-live="polite" style={stackStyle}>
                {Object.entries(view.status).map(([key, text]) => <div key={key} style={{ whiteSpace: "pre-wrap" }}>{text}</div>)}
            </div>}
            {view && view.notices.length > 0 && <div aria-live="polite" style={{ ...stackStyle, maxHeight: "25vh", overflowY: "auto", flexShrink: 0 }}>
                {view.notices.map((notice, index) => <div key={index} role={notice.level === "error" ? "alert" : "status"}
                    style={{ borderLeft: `3px solid ${notice.level === "error" ? "#d64545" : notice.level === "warning" ? "#c79217" : "#6486c5"}`, paddingLeft: 10, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                ><strong>{notice.level === "warning" ? "Warning: " : notice.level === "error" ? "Error: " : ""}</strong>{notice.text}</div>)}
            </div>}
            {dialog && view?.runId && <DialogForm key={`${view.runId}:${dialog.id}`} dialog={dialog} busy={state.busy}
                answer={(value) => { void surface.answer(view.runId!, dialog.id, value); }} />}
            {!dialog && !state.error && <div role="status">{view?.done ? "CasePick finished." : "CasePick is working…"}</div>}
            {view?.done && !dialog && <button type="button" style={buttonStyle} onClick={surface.close}>Close</button>}
        </div>
    </Modal>;
}

interface SettingsCardProps {
    rpc: Rpc;
    useSessions: UseSessions;
    surfaceFor: (sessionId: string) => SessionSurface;
}

function SettingsCard({ rpc, useSessions, surfaceFor }: SettingsCardProps): React.ReactElement {
    const sessionId = useSessions((sessions) => sessions.current);
    const [settings, setSettings] = React.useState<NativeSettings>();
    const [error, setError] = React.useState<string>();
    const [saving, setSaving] = React.useState(false);
    const alive = React.useRef(false);
    React.useEffect(() => {
        alive.current = true;
        const controller = new AbortController();
        const refresh = () => {
            void call<NativeSettings>(rpc, "settings", {}, controller.signal).then((value) => {
                if (!controller.signal.aborted) {
                    setSettings(value);
                    setError(undefined);
                }
            }).catch((reason: unknown) => {
                if (!controller.signal.aborted) setError(errorMessage(reason));
            });
        };
        refresh();
        const surface = sessionId ? surfaceFor(sessionId) : undefined;
        const initialView = surface?.getSnapshot().view;
        let finishedRun = initialView?.done ? initialView.runId : undefined;
        const unsubscribe = surface?.subscribe(() => {
            const view = surface.getSnapshot().view;
            if (view?.done && view.runId !== finishedRun) {
                finishedRun = view.runId;
                refresh();
            }
        });
        return () => {
            alive.current = false;
            controller.abort();
            unsubscribe?.();
        };
    }, [rpc, sessionId, surfaceFor]);

    const updateDebug = async (debug: boolean) => {
        if (saving) return;
        setSaving(true);
        setError(undefined);
        try {
            const value = await call<NativeSettings>(rpc, "settings/update", { debug });
            if (alive.current) setSettings(value);
        } catch (reason) {
            if (alive.current) setError(errorMessage(reason));
        } finally {
            if (alive.current) setSaving(false);
        }
    };

    return <section aria-label="CasePick settings" style={{ ...stackStyle, padding: 16, border: "1px solid currentColor", borderRadius: 8 }}>
        <h3 style={{ margin: 0 }}>CasePick</h3>
        <label style={{ ...rowStyle, alignItems: "center" }}>
            <input type="checkbox" checked={settings?.debug ?? false} disabled={!settings || saving}
                onChange={(event) => { void updateDebug(event.target.checked); }} />
            Debug mode (diagnostics kept in memory)
        </label>
        <small>Saved to the native DSH CasePick settings.</small>
        {settings && <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", margin: 0 }}>
            <dt>Draft model</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{settings.draftModel || "Current session model"}</dd>
            <dt>Reasoning</dt><dd style={{ margin: 0 }}>{settings.reasoning || "Default"}</dd>
            <dt>Max output tokens</dt><dd style={{ margin: 0 }}>{settings.maxOutputTokens ?? "CasePick configuration"}</dd>
            <dt>Timeout</dt><dd style={{ margin: 0 }}>{settings.timeoutSeconds === null ? "CasePick configuration" : `${settings.timeoutSeconds}s`}</dd>
        </dl>}
        {error && <div role="alert" style={{ color: "#d64545", whiteSpace: "pre-wrap" }}>{error}</div>}
        <button type="button" style={buttonStyle} disabled={!sessionId} onClick={() => {
            if (sessionId) void surfaceFor(sessionId).open("config");
        }}>Open CasePick configuration</button>
        {!sessionId && <small>Select a conversation to configure CasePick models and generation options.</small>}
    </section>;
}

export function apply(ctx: ClientContext): void {
    const surfaces = new Map<string, SessionSurface>();
    const surfaceFor = (sessionId: string): SessionSurface => {
        let surface = surfaces.get(sessionId);
        if (!surface) {
            surface = new SessionSurface(ctx.connection.rpc, sessionId);
            surfaces.set(sessionId, surface);
        }
        return surface;
    };
    ctx.effect(() => () => {
        for (const surface of surfaces.values()) surface.dispose();
        surfaces.clear();
    }, "casepick: session surfaces");
    ctx.effect(() => ctx.commandUi.decorate({
        name: "casepick",
        available: () => true,
        ui: { kind: "action", run: ({ sessionId }) => { void surfaceFor(sessionId).open(); } },
    }), "casepick: bare host command decoration");
    ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
        name: "conversation.input.overlay",
        id: "casepick-dialog",
        order: 10,
        inject: (sessionId) => ({ surface: surfaceFor(sessionId) }),
    }, SessionOverlay));
    ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: "casepick",
        inject: () => ({ rpc: ctx.connection.rpc, surfaceFor }),
    }, SettingsCard));
}
