import * as React from "react";
import type { Context } from "@deepseek-ai/cordis";
import type { ClientConnectionRpc, ConnectionHandle } from "@deepseek-ai/dsh-client-connection/client";
import type {} from "@deepseek-ai/dsh-client-ui-commands/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { MainPanelId } from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { SidebarPanelIconOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import {
    Button, focusWithoutRing, IconChecklistOutlineRegular, IconCheckCircleFillRegular,
    IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseCircleFillRegular,
    IconInfoOutlineRegular, IconWarningOutlineRegular, Input, ShortcutKeys, StateDot, Switch, Tag, TextShimmer,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { reasoningLevels } from "../core/reasoning.js";
import { rpcPath, type Dialog, type NativeSettings, type ViewState, type WorkspaceSession } from "./protocol.js";
import { settingError, settingKeys, settingRanges, type SettingKey } from "./settings-patch.js";
import { injectStyles } from "./styles.js";
import { Workspace, WorkspaceNavigation, type WorkspaceSurface } from "./workspace.js";

export const name = "casepick";
export const inject = ["commandUi", "connection", "slots", "layout"];
// Sidebar row id and main-panel key of the standalone CasePick page.
const PANEL_ID = "casepick";

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

    constructor(private readonly rpc: Rpc, readonly sessionId: string, private readonly discover: (sessionId: string) => void) {}

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
        if (discover && !view.done && previous?.runId !== view.runId) this.discover(this.sessionId);
    }

    attach(): () => void {
        this.mounts++;
        this.beginPolling();
        return () => {
            if (--this.mounts !== 0) return;
            this.poll?.abort();
            this.poll = undefined;
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

    readonly open = async (args = "", cutoffEntry?: string, watermark?: number): Promise<void> => {
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
            // A returned run always needs an explicit identity-fenced cancellation.
            const view = await call<ViewState>(this.rpc, "start", { sessionId: this.sessionId, args, cutoffEntry, watermark });
            if (serial !== this.startSerial || this.disposed) {
                if (view.runId && !view.done) {
                    this.dismissedRun = view.runId;
                    await this.cancelRun(view.runId).catch((error: unknown) => {
                        this.update({ open: true, error: `无法取消 CasePick：${errorMessage(error)}` });
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
                this.update({ open: true, error: `无法取消 CasePick：${errorMessage(error)}` });
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

function Notice({ level, children }: {
    level: "info" | "warning" | "error";
    children: React.ReactNode;
}): React.ReactElement {
    const Icon = level === "error" ? IconCloseCircleFillRegular
        : level === "warning" ? IconWarningOutlineRegular : IconInfoOutlineRegular;
    return <div className="casepick-notice" data-level={level} role={level === "error" ? "alert" : "status"}>
        <span className="casepick-notice-icon" aria-hidden="true"><Icon size={16} /></span>
        <div className="casepick-notice-text">{children}</div>
    </div>;
}

function DialogForm({ dialog, busy, text, setText, answer }: {
    dialog: Dialog;
    busy: boolean;
    text: string;
    setText: (text: string) => void;
    answer: (value: string | boolean | null) => void;
}): React.ReactElement {
    const hintId = React.useId();
    return <div className="casepick-stack">
        {dialog.message !== undefined && <p className="casepick-message">{dialog.message}</p>}
        {dialog.kind === "select" && <div className="casepick-options" onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
            const index = options.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
            options[next]?.focus();
        }}>
            {(dialog.options ?? []).map((option, index) => <button
                key={index} type="button" disabled={busy} data-casepick-autofocus={index === 0 ? "" : undefined}
                className="casepick-option"
                onClick={() => answer(option)}
            >
                <span className="casepick-option-text">{option}</span>
                <span className="casepick-option-icon" aria-hidden="true"><IconChevronRightOutlineRegular size={16} /></span>
            </button>)}
        </div>}
        {dialog.kind === "editor" && <>
            <textarea
                aria-label={dialog.title.split("\n")[0]} aria-describedby={hintId}
                data-casepick-autofocus="" rows={10} value={text} disabled={busy} className="casepick-editor"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if (!busy) answer(text);
                    }
                }}
            />
            <div id={hintId} className="casepick-shortcuts">
                <span><ShortcutKeys keys={["Enter"]} /> 提交</span>
                <span aria-hidden="true">·</span>
                <span><ShortcutKeys keys={["Shift", "+", "Enter"]} /> 换行</span>
            </div>
        </>}
    </div>;
}

function WorkflowPanel({ surface, onComplete }: { surface: SessionSurface; onComplete: () => void }): React.ReactElement {
    const state = React.useSyncExternalStore(surface.subscribe, surface.getSnapshot, surface.getSnapshot);
    React.useEffect(() => surface.attach(), [surface]);
    const [editor, setEditor] = React.useState({ key: "", text: "" });
    const body = React.useRef<HTMLElement>(null);
    const view = state.view;
    const dialog = view?.dialog;
    const key = `${view?.runId ?? ""}:${dialog?.id ?? ""}`;
    const text = editor.key === key ? editor.text : dialog?.prefill ?? "";
    const [title, ...detail] = dialog?.title.split("\n") ?? [];
    const detailText = detail.join("\n").replace(/^\n+/, "");
    const status = Object.values(view?.status ?? {}).join("\n");
    const finished = view?.done && !state.busy;
    const failed = !!state.error || !!view?.notices.some((notice) => notice.level === "error");
    const answer = (value: string | boolean | null) => {
        if (dialog && view?.runId) void surface.answer(view.runId, dialog.id, value);
    };
    React.useEffect(() => {
        if (view?.runId && view.done) onComplete();
    }, [view?.runId, view?.done, onComplete]);
    React.useLayoutEffect(() => {
        if (!state.open || state.busy) return;
        const target = body.current?.querySelector<HTMLElement>("[data-casepick-autofocus]:not(:disabled)");
        if (target) focusWithoutRing(target);
        const workspace = body.current?.closest(".casepick-workspace");
        if (workspace && workspace.clientWidth <= 900) body.current?.scrollIntoView({ block: "nearest" });
    }, [key, state.busy, state.open]);
    return <aside ref={body} className="casepick-workflow" aria-label="审阅与保存">
        <header className="casepick-section-heading">
            <div><span className="casepick-eyebrow">工作流</span><h2>审阅与保存</h2></div>
            {state.open && <Button variant="ghost" disabled={state.busy} onClick={surface.close}>
                {finished ? "清除" : "结束运行"}
            </Button>}
        </header>
        <div className="casepick-stack casepick-workflow-body" aria-busy={state.busy}>
            {state.open && dialog && <h3 className="casepick-dialog-title">{title}</h3>}
            {state.open && detailText && <div className="casepick-detail" tabIndex={0} role="region" aria-label="详细内容">{detailText}</div>}
            {state.error && <Notice level="error">{state.error}</Notice>}
            {state.open && dialog && status && <details className="casepick-status-context">
                <summary>上下文与运行状态</summary><pre className="casepick-detail">{status}</pre>
            </details>}
            {state.open && !dialog && !state.error && <div role="status" aria-live="polite" className="casepick-status">
                <StateDot state={finished ? failed ? "error" : "done" : "ongoing"} />
                <TextShimmer active={!finished} className="casepick-status-text">
                    {finished ? "CasePick 已结束。" : status || "CasePick 正在处理…"}
                </TextShimmer>
            </div>}
            {state.open && dialog && view?.runId && <DialogForm key={`${view.runId}:${dialog.id}`} dialog={dialog} busy={state.busy}
                text={text} setText={(text) => setEditor({ key, text })} answer={answer} />}
            {state.open && view && view.notices.length > 0 && <div aria-live="polite" className="casepick-notices"
                tabIndex={0} role="region" aria-label="运行提示">
                <Notice level={view.notices[view.notices.length - 1].level}>{view.notices[view.notices.length - 1].text}</Notice>
                {view.notices.length > 1 && <details><summary>之前的运行记录（{view.notices.length - 1} 条）</summary>
                    {view.notices.slice(0, -1).map((notice, index) => <Notice key={index} level={notice.level}>{notice.text}</Notice>)}
                </details>}
            </div>}
        </div>
        {state.open && dialog && view?.runId && <footer className="casepick-workflow-actions">
            <Button variant="ghost" className="casepick-action" disabled={state.busy} onClick={() => answer(null)}>取消此步</Button>
            {dialog.kind === "confirm" && <>
                <Button variant="outline" className="casepick-action" disabled={state.busy} onClick={() => answer(false)}>否</Button>
                <Button variant="primary" className="casepick-action" data-casepick-autofocus=""
                    disabled={state.busy} onClick={() => answer(true)}>是</Button>
            </>}
            {dialog.kind === "editor" && <Button variant="primary" className="casepick-action"
                disabled={state.busy} onClick={() => answer(text)}>{state.busy ? "正在提交…" : "提交"}</Button>}
        </footer>}
        {!state.open && <div className="casepick-empty">
            <IconChecklistOutlineRegular size={24} />
            <h3>从会话到评测案例</h3>
            <p>选择会话与原出错回复，开始审阅。证据、切片、模型起草、预览与保存都在此处完成。</p>
        </div>}
    </aside>;
}

/** Staged page text; numbers stay text so invalid input can be shown, not rewritten. */
interface Draft {
    debug: boolean;
    draftModel: string;
    reasoning: string;
    maxOutputTokens: string;
    timeoutSeconds: string;
}

function toDraft(settings: NativeSettings): Draft {
    return {
        debug: settings.debug, draftModel: settings.draftModel, reasoning: settings.reasoning,
        maxOutputTokens: settings.maxOutputTokens == null ? "" : String(settings.maxOutputTokens),
        timeoutSeconds: settings.timeoutSeconds == null ? "" : String(settings.timeoutSeconds),
    };
}

// A blank number clears the override, which falls back to /casepick config.
function fromDraft(draft: Draft): Record<SettingKey, unknown> {
    const number = (text: string) => text.trim() === "" ? null : Number(text.trim());
    return { ...draft, maxOutputTokens: number(draft.maxOutputTokens), timeoutSeconds: number(draft.timeoutSeconds) };
}

function Field({ id, label, hint, error, modified, children }: {
    id: string;
    label: string;
    hint: string;
    error: string | undefined;
    modified: boolean;
    children: React.ReactNode;
}): React.ReactElement {
    return <div className={`casepick-field${error ? " casepick-field-invalid" : ""}`}>
        <div className="casepick-field-copy">
            <div className="casepick-field-heading">
                <label htmlFor={id}>{label}</label>
                {modified && <Tag tone="info">已修改</Tag>}
            </div>
            <small id={`${id}-hint`} role={error ? "alert" : undefined} className="casepick-hint">{error ?? hint}</small>
        </div>
        <div className="casepick-field-control">{children}</div>
    </div>;
}

interface SettingsPageProps {
    rpc: Rpc;
    session?: WorkspaceSession;
    openConfig: (sessionId: string) => void;
}

function SettingsPage({ rpc, session, openConfig }: SettingsPageProps): React.ReactElement {
    const sessionId = session?.id;
    const [saved, setSaved] = React.useState<NativeSettings>();
    const [draft, setDraft] = React.useState<Draft>();
    const [error, setError] = React.useState<string>();
    const [notice, setNotice] = React.useState<string>();
    const [saving, setSaving] = React.useState(false);
    const [loads, setLoads] = React.useState(0);
    const alive = React.useRef(false);
    React.useEffect(() => {
        alive.current = true;
        const controller = new AbortController();
        void call<NativeSettings>(rpc, "settings", {}, controller.signal).then((value) => {
            if (controller.signal.aborted) return;
            setSaved(value);
            setDraft(toDraft(value));
            setError(undefined);
        }).catch((reason: unknown) => {
            if (!controller.signal.aborted) setError(errorMessage(reason));
        });
        return () => {
            alive.current = false;
            controller.abort();
        };
    }, [rpc, loads]);

    const values = draft && fromDraft(draft);
    const stored = saved && fromDraft(toDraft(saved));
    const errors = {} as Record<SettingKey, string | undefined>;
    for (const key of settingKeys) errors[key] = values && settingError(key, values[key]);
    const invalid = settingKeys.some((key) => errors[key] !== undefined);
    const patch = values && stored
        ? Object.fromEntries(settingKeys.filter((key) => !Object.is(values[key], stored[key])).map((key) => [key, values[key]]))
        : {};
    const dirty = Object.keys(patch).length > 0;
    const disabled = !draft || saving;
    const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
        setDraft((current) => current && { ...current, [key]: value });
        setNotice(undefined);
    };

    const save = async () => {
        if (disabled || invalid || !dirty) return;
        setSaving(true);
        setError(undefined);
        setNotice(undefined);
        try {
            const value = await call<NativeSettings>(rpc, "settings/update", patch);
            if (!alive.current) return;
            setSaved(value);
            setDraft(toDraft(value));
            setNotice("已保存，之后的 CasePick 运行使用新设置。");
        } catch (reason) {
            if (alive.current) setError(errorMessage(reason));
        } finally {
            if (alive.current) setSaving(false);
        }
    };

    const field = (key: SettingKey) => ({ id: `casepick-${key}`, error: errors[key] });
    const inputProps = (key: "draftModel" | "maxOutputTokens" | "timeoutSeconds") => ({
        id: `casepick-${key}`, value: draft?.[key] ?? "", disabled,
        "aria-invalid": errors[key] !== undefined, "aria-describedby": `casepick-${key}-hint`,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(key, event.target.value),
    });
    const range = (key: keyof typeof settingRanges) => `${settingRanges[key][0]}–${settingRanges[key][1]} 的整数；留空沿用 /casepick config`;

    return <section aria-label="CasePick" className="casepick-page">
        <div className="casepick-page-inner">
            <header className="casepick-page-heading">
                <span className="casepick-page-mark" aria-hidden="true"><IconChecklistOutlineRegular size={24} /></span>
                <div>
                    <h1>设置</h1>
                    <p className="casepick-page-intro">管理 CasePick 运行参数与默认配置。</p>
                </div>
            </header>
            <form aria-label="CasePick 设置" className="casepick-settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
                <section className="casepick-card" aria-labelledby="casepick-runtime-heading" aria-busy={!draft && !error || saving}>
                    <header className="casepick-card-heading">
                        <h2 id="casepick-runtime-heading">运行设置</h2>
                        <p className="casepick-hint">由 DSH 保存，填写的项优先于 <code>/casepick config</code>，留空的项沿用它。</p>
                    </header>
                    <div className="casepick-field casepick-field-toggle">
                        <div className="casepick-field-copy">
                            <div className="casepick-field-heading">
                                <span>调试模式</span>
                                {"debug" in patch && <Tag tone="info">已修改</Tag>}
                            </div>
                            <p className="casepick-hint">查看每次请求、原始回复、解析及核对诊断；只在当次界面展示，不另存诊断文件。</p>
                        </div>
                        <div className="casepick-field-control">
                            <span className="casepick-hint">{draft ? draft.debug ? "已开启" : "已关闭" : "读取中"}</span>
                            <Switch label="调试模式" checked={draft?.debug ?? false} disabled={disabled} onChange={(debug) => set("debug", debug)} />
                        </div>
                    </div>
                    <Field {...field("draftModel")} modified={"draftModel" in patch} label="起草模型"
                        hint="current：工作区所选会话的模型；off：不使用模型；或填写 provider/model。">
                        <Input {...inputProps("draftModel")} className="casepick-input" placeholder="沿用 /casepick config" autoComplete="off" spellCheck={false} />
                    </Field>
                    <Field {...field("reasoning")} modified={"reasoning" in patch} label="思考等级" hint="模型不支持所选等级时自动降级。">
                        <div className="casepick-select-wrap">
                            <select id="casepick-reasoning" aria-describedby="casepick-reasoning-hint"
                                aria-invalid={errors.reasoning !== undefined} className="casepick-select"
                                value={draft?.reasoning ?? ""} disabled={disabled} onChange={(event) => set("reasoning", event.target.value)}>
                                <option value="">沿用 /casepick config</option>
                                {reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
                            </select>
                            <span className="casepick-select-icon" aria-hidden="true"><IconChevronDownOutlineRegular size={14} /></span>
                        </div>
                    </Field>
                    <Field {...field("maxOutputTokens")} modified={"maxOutputTokens" in patch} label="单次输出上限（tokens）" hint={range("maxOutputTokens")}>
                        <Input {...inputProps("maxOutputTokens")} className="casepick-input" inputMode="numeric" placeholder="沿用 /casepick config" />
                    </Field>
                    <Field {...field("timeoutSeconds")} modified={"timeoutSeconds" in patch} label="单次超时（秒）" hint={range("timeoutSeconds")}>
                        <Input {...inputProps("timeoutSeconds")} className="casepick-input" inputMode="numeric" placeholder="沿用 /casepick config" />
                    </Field>
                </section>
                <section aria-labelledby="casepick-wizard-heading" className="casepick-card casepick-wizard">
                    <header className="casepick-card-heading">
                        <h2 id="casepick-wizard-heading">配置向导</h2>
                        <p className="casepick-hint">选择起草模型、思考等级及外发同意等默认配置，保存至 CasePick 本地配置文件。向导在工作区内完成。</p>
                    </header>
                    <Button variant="outline" className="casepick-wizard-button" disabled={!sessionId || dirty}
                        onClick={() => { if (sessionId) openConfig(sessionId); }}>
                        打开 /casepick config 配置向导 <IconChevronRightOutlineRegular size={14} />
                    </Button>
                    <small className="casepick-hint">{!sessionId
                        ? "先在 CasePick 的会话列表中选择一个会话。"
                        : dirty ? "有未保存的修改，请先保存或还原。" : `将使用工作区会话「${session?.title || sessionId}」打开向导。`}</small>
                </section>
                {error && <Notice level="error">{error}</Notice>}
                <footer className="casepick-savebar">
                    <div role="status" aria-live="polite" className="casepick-status">
                        {saving || !draft && !error ? <><StateDot state="ongoing" /><span>{saving ? "正在保存…" : "正在读取设置…"}</span></>
                            : error ? <><StateDot state="error" /><span className="casepick-failed">{draft ? "保存失败，请重试。" : "读取设置失败。"}</span></>
                            : invalid ? <><StateDot state="warning" /><span>请修正标出的设置项</span></>
                            : dirty ? <><StateDot state="warning" /><span>{Object.keys(patch).length} 项未保存</span></>
                            : <><span className={notice ? "casepick-success" : "casepick-muted"} aria-hidden="true"><IconCheckCircleFillRegular size={16} /></span>
                                <span>{notice ?? "所有设置已保存"}</span></>}
                    </div>
                    <div className="casepick-actions">
                        {!draft && error
                            ? <Button variant="outline" className="casepick-action" onClick={() => { setError(undefined); setLoads((count) => count + 1); }}>重试</Button>
                            : <>
                                <Button variant="ghost" className="casepick-action" disabled={disabled || !dirty}
                                    onClick={() => { if (saved) setDraft(toDraft(saved)); setNotice(undefined); }}>还原</Button>
                                <Button type="submit" variant="primary" className="casepick-action" disabled={disabled || invalid || !dirty}>
                                    {saving ? "正在保存…" : "保存"}
                                </Button>
                            </>}
                    </div>
                </footer>
            </form>
        </div>
    </section>;
}

/** Native command runs are observed here, but every interaction lives in the main workspace. */
function SessionObserver({ surface }: { surface: SessionSurface }): null {
    React.useEffect(() => surface.attach(), [surface]);
    return null;
}

function CasePickIcon({ size }: SidebarPanelIconOwnerProps): React.ReactElement {
    return <IconChecklistOutlineRegular size={size} />;
}

export function apply(ctx: ClientContext): void {
    ctx.effect(() => injectStyles(), "casepick: styles");
    const surfaces = new Map<string, SessionSurface>();
    const navigation = new WorkspaceNavigation();
    const focusSession = (sessionId: string) => {
        navigation.select("sessions", sessionId);
        ctx.layout.selectPanel(PANEL_ID as MainPanelId);
    };
    const surfaceFor = (sessionId: string): SessionSurface => {
        let surface = surfaces.get(sessionId);
        if (!surface) {
            surface = new SessionSurface(ctx.connection.rpc, sessionId, focusSession);
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
        ui: { kind: "action", run: ({ sessionId }) => {
            focusSession(sessionId);
            void surfaceFor(sessionId).open();
        } },
    }), "casepick: bare host command decoration");
    ctx.slots.inject("conversation.input.overlay", () => ctx.slots.register({
        name: "conversation.input.overlay",
        id: "casepick-command-observer",
        order: 10,
        inject: (sessionId) => ({ surface: surfaceFor(sessionId) }),
    }, SessionObserver));
    ctx.slots.inject("main", () => ctx.slots.register({
        name: "main",
        key: PANEL_ID,
        inject: () => ({
            rpc: ctx.connection.rpc, navigation, surfaceFor,
            renderSettings: (session: WorkspaceSession | undefined, openConfig: (sessionId: string) => void) =>
                <SettingsPage rpc={ctx.connection.rpc} session={session} openConfig={openConfig} />,
            renderWorkflow: (surface: WorkspaceSurface, onComplete: () => void) =>
                <WorkflowPanel key={surface.sessionId} surface={surfaceFor(surface.sessionId)} onComplete={onComplete} />,
        }),
    }, Workspace));
    ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist",
        id: PANEL_ID,
        order: 100,
        label: "CasePick",
    }, CasePickIcon));
}
