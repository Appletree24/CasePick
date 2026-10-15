import { randomUUID } from "node:crypto";
import type { WorkflowUI } from "../host.ts";
import type { Dialog, Notice, ViewState } from "./protocol.ts";

interface Pending {
    dialog: Dialog;
    resolve(value: string | boolean | undefined): void;
    reject(error: unknown): void;
}

// 一个接收会话拥有一个控制器；run/dialog 身份隔离旧浏览器答复和取消。
export class DialogBridge {
    private revision = 0;
    private runId?: string;
    private abort?: AbortController;
    private pending?: Pending;
    private notices: Notice[] = [];
    private status: Record<string, string> = {};
    private done = true;
    private readonly listeners = new Set<() => void>();

    private readonly sessionId: string;
    constructor(sessionId: string) { this.sessionId = sessionId; }

    snapshot(): ViewState {
        return {
            sessionId: this.sessionId, revision: this.revision,
            ...(this.runId ? { runId: this.runId } : {}),
            ...(this.pending ? { dialog: this.pending.dialog } : {}),
            notices: [...this.notices], status: { ...this.status }, done: this.done,
        };
    }

    begin(): { id: string; signal: AbortSignal; ui: WorkflowUI } | undefined {
        if (this.runId && !this.done) return undefined;
        const id = randomUUID();
        this.runId = id;
        this.abort = new AbortController();
        this.notices = [];
        this.status = {};
        this.done = false;
        this.changed();
        const ui: WorkflowUI = {
            select: async (title, options) => await this.ask(id, { kind: "select", title, options }) as string | undefined,
            confirm: async (title, message) => (await this.ask(id, { kind: "confirm", title, message })) === true,
            editor: async (title, prefill) => await this.ask(id, { kind: "editor", title, prefill: prefill ?? "" }) as string | undefined,
            notify: (text, level = "info") => {
                if (this.runId !== id || this.abort?.signal.aborted) return;
                this.notices.push({ text, level });
                this.changed();
            },
            setStatus: (key, text) => {
                if (this.runId !== id || this.abort?.signal.aborted || this.status[key] === text) return;
                if (text === undefined) delete this.status[key];
                else this.status[key] = text;
                this.changed();
            },
        };
        return { id, signal: this.abort.signal, ui };
    }

    private ask(runId: string, dialog: Omit<Dialog, "id">): Promise<string | boolean | undefined> {
        if (this.runId !== runId || this.abort?.signal.aborted) return Promise.reject(new DOMException("操作已取消", "AbortError"));
        if (this.pending) return Promise.reject(new Error("同一工作流不能同时打开两个对话框"));
        const { promise, resolve, reject } = Promise.withResolvers<string | boolean | undefined>();
        this.pending = { dialog: { ...dialog, id: randomUUID() }, resolve, reject };
        this.changed();
        return promise;
    }

    answer(runId: string, dialogId: string, value: unknown): ViewState {
        const pending = this.pending;
        if (runId !== this.runId || !pending || dialogId !== pending.dialog.id) throw new Error("对话框已失效，请使用当前对话框");
        const { dialog } = pending;
        if (value !== null) {
            if (dialog.kind === "confirm" && typeof value !== "boolean") throw new TypeError("确认结果必须是布尔值");
            if (dialog.kind === "editor" && typeof value !== "string") throw new TypeError("编辑结果必须是文字");
            if (dialog.kind === "select" && (typeof value !== "string" || !dialog.options?.includes(value))) throw new TypeError("选项不属于当前对话框");
        }
        this.pending = undefined;
        pending.resolve(value === null ? undefined : value as string | boolean);
        this.changed();
        return this.snapshot();
    }

    finish(runId: string, error?: unknown): void {
        if (this.runId !== runId) return;
        if (error !== undefined && !this.abort?.signal.aborted) this.notices.push({ text: error instanceof Error ? error.message : String(error), level: "error" });
        this.pending?.reject(new DOMException("工作流已结束", "AbortError"));
        this.pending = undefined;
        this.status = {};
        this.done = true;
        this.changed();
    }

    cancel(runId: string): ViewState {
        if (this.runId !== runId) throw new Error("工作流已失效");
        this.abort?.abort(new DOMException("用户关闭 CasePick", "AbortError"));
        this.pending?.reject(this.abort?.signal.reason);
        this.pending = undefined;
        this.runId = undefined;
        this.status = {};
        this.notices = [];
        this.done = true;
        this.changed();
        return this.snapshot();
    }

    async wait(revision: number | undefined, signal: AbortSignal): Promise<ViewState> {
        signal.throwIfAborted();
        if (revision !== this.revision) return this.snapshot();
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const cleanup = () => {
            clearTimeout(timer);
            this.listeners.delete(change);
            signal.removeEventListener("abort", abort);
        };
        const change = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const timer = setTimeout(change, 20_000);
        timer.unref();
        this.listeners.add(change);
        signal.addEventListener("abort", abort, { once: true });
        await promise;
        return this.snapshot();
    }

    dispose(): void {
        if (this.runId) this.cancel(this.runId);
        for (const listener of this.listeners) listener();
    }

    private changed(): void {
        this.revision++;
        for (const listener of this.listeners) listener();
    }
}
