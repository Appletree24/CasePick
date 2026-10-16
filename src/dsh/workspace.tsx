import * as React from "react";
import type { ClientConnectionRpc } from "@deepseek-ai/dsh-client-connection/client";
import { Button, IconChecklistOutlineRegular, Input, StateDot, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import { rpcPath, type ViewState, type WorkspaceLibrary, type WorkspaceLibraryDetail, type WorkspaceSession, type WorkspaceSnapshot } from "./protocol.js";

type WorkspaceTab = "sessions" | "cases" | "issues" | "settings";
interface NavigationState { tab: WorkspaceTab; sessionId?: string }

/** Navigation is intentionally independent of the native chat session selection. */
export class WorkspaceNavigation {
    private state: NavigationState = { tab: "sessions" };
    private readonly listeners = new Set<() => void>();
    readonly getSnapshot = (): NavigationState => this.state;
    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    select(tab: WorkspaceTab, sessionId = this.state.sessionId): void {
        this.state = { tab, sessionId };
        for (const listener of this.listeners) listener();
    }
}

interface WorkflowState { busy: boolean; view?: ViewState }
export interface WorkspaceSurface {
    readonly sessionId: string;
    getSnapshot: () => WorkflowState;
    subscribe: (listener: () => void) => () => void;
    open: (args?: string, cutoffEntry?: string, watermark?: number) => Promise<void>;
}
interface WorkspaceProps {
    rpc: ClientConnectionRpc;
    navigation: WorkspaceNavigation;
    surfaceFor: (sessionId: string) => WorkspaceSurface;
    renderSettings: (session: WorkspaceSession | undefined, openConfig: (sessionId: string) => void) => React.ReactNode;
    renderWorkflow: (surface: WorkspaceSurface, onComplete: () => void) => React.ReactNode;
}

async function call<T>(rpc: ClientConnectionRpc, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const result = await rpc.call(rpcPath, "casepick", { endpoint, payload }, signal);
    if (!result.ok) throw new Error(result.error.message);
    return result.value as T;
}
function dateLabel(value: string | number | undefined): string {
    if (value === undefined) return "";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
function readableArguments(value: string): string {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}
function LoadError({ error }: { error?: string }): React.ReactElement | null {
    return error ? <div role="alert" className="casepick-notice" data-level="error">{error}</div> : null;
}
const roleLabels: Record<string, string> = {
    assistant: "助手", user: "用户", tool: "工具", system: "系统", developer: "开发者",
};

function SessionTimeline({ snapshot, loading, error, cutoff, setCutoff, refresh, start, running }: {
    snapshot?: WorkspaceSnapshot;
    loading: boolean;
    error?: string;
    cutoff?: string;
    setCutoff: (value: string | undefined) => void;
    refresh: () => void;
    start: (cutoff?: string) => void;
    running: boolean;
}): React.ReactElement {
    const [query, setQuery] = React.useState("");
    const entries = snapshot?.entries.filter((entry) =>
        `${entry.role}\n${entry.content}\n${entry.toolCalls?.map((tool) => `${tool.name} ${tool.arguments}`).join("\n") ?? ""}`
            .toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
    return <section className="casepick-timeline" aria-label="会话时间线">
        <header className="casepick-section-heading">
            <div><span className="casepick-eyebrow">会话记录</span><h2>{snapshot?.session.title || "时间线"}</h2></div>
            <Button variant="ghost" disabled={loading} onClick={refresh}>刷新</Button>
        </header>
        {snapshot && <div className="casepick-timeline-toolbar">
            <Input aria-label="搜索会话内容" placeholder="搜索消息或工具…" value={query}
                onChange={(event) => setQuery(event.target.value)} />
            <span className="casepick-hint">{snapshot.entries.length} 条记录 · 快照 #{snapshot.watermark}</span>
            <span className="casepick-hint casepick-path" title={snapshot.session.cwd}>{snapshot.session.cwd}</span>
        </div>}
        <div className="casepick-timeline-entries" aria-busy={loading}>
            {loading && <div className="casepick-loading" role="status"><StateDot state="ongoing" />正在读取会话…</div>}
            <LoadError error={error} />
            {!loading && !error && !snapshot && <div className="casepick-empty"><h3>选择一个会话</h3><p>从左侧浏览历史记录，无需恢复、分叉或切换当前聊天。</p></div>}
            {!loading && snapshot && entries.length === 0 && <div className="casepick-empty"><p>{query ? "没有匹配的记录。" : "此会话尚无可展示的记录。"}</p></div>}
            {entries.map((entry) => <article key={entry.id} className="casepick-entry" data-role={entry.role}
                data-selected={cutoff === entry.id || undefined}>
                <header>
                    {entry.role === "assistant" ? <Tag tone="info">助手</Tag> : <span className="casepick-role">{roleLabels[entry.role] ?? entry.role}</span>}
                    <span className="casepick-entry-id">{entry.id}</span>
                    {entry.at && <time className="casepick-hint" dateTime={entry.at}>{dateLabel(entry.at)}</time>}
                    {entry.role === "assistant" && <label className="casepick-cutoff">
                        <input type="radio" name="casepick-cutoff" checked={cutoff === entry.id}
                            onChange={() => setCutoff(entry.id)} />
                        {cutoff === entry.id ? "已选为出错回复" : "选择此回复"}
                    </label>}
                </header>
                {entry.content && <div className="casepick-entry-content">{entry.content}</div>}
                {entry.toolCalls?.map((tool) => <details className="casepick-tool" key={tool.id}>
                    <summary>工具调用 · {tool.name} <span className="casepick-hint">{tool.id}</span></summary>
                    <pre>{readableArguments(tool.arguments)}</pre>
                </details>)}
                {!entry.content && !entry.toolCalls?.length && <p className="casepick-hint">无文本内容</p>}
            </article>)}
        </div>
        {snapshot && <footer className="casepick-timeline-footer">
            <div className="casepick-hint">{cutoff ? `审阅截止于 ${cutoff}` : "可选中一条助手回复直接审阅，或扫描整个会话。"}</div>
            <div className="casepick-actions">
                {cutoff && <Button variant="ghost" onClick={() => setCutoff(undefined)}>清除选择</Button>}
                <Button variant="primary" disabled={running || loading} onClick={() => start(cutoff)}>
                    {running ? "工作流进行中" : cutoff ? "审阅所选回复" : "扫描会话"}
                </Button>
            </div>
        </footer>}
    </section>;
}

function LibraryPanel({ rpc, kind, library, loading, error, refresh, manageIssues, hasSession }: {
    rpc: ClientConnectionRpc;
    kind: "cases" | "issues";
    library?: WorkspaceLibrary;
    loading: boolean;
    error?: string;
    refresh: () => void;
    manageIssues: () => void;
    hasSession: boolean;
}): React.ReactElement {
    const [query, setQuery] = React.useState("");
    const [selectedId, setSelectedId] = React.useState<string>();
    const [detail, setDetail] = React.useState<WorkspaceLibraryDetail>();
    const [detailError, setDetailError] = React.useState<string>();
    const [detailLoading, setDetailLoading] = React.useState(false);
    React.useEffect(() => {
        const controller = new AbortController();
        setDetail(undefined);
        setDetailError(undefined);
        setDetailLoading(!!selectedId);
        if (selectedId) {
            void call<WorkspaceLibraryDetail>(rpc, "library/read", { kind: kind === "cases" ? "case" : "issue", id: selectedId }, controller.signal)
                .then((value) => { if (!controller.signal.aborted) setDetail(value); })
                .catch((error: unknown) => {
                    if (!controller.signal.aborted) setDetailError(String(error instanceof Error ? error.message : error));
                }).finally(() => { if (!controller.signal.aborted) setDetailLoading(false); });
        }
        return () => controller.abort();
    }, [rpc, kind, selectedId, library]);
    const items = library?.[kind] ?? [];
    const selected = items.find((item) => item.id === selectedId);
    const selectedCase = kind === "cases" ? library?.cases.find((item) => item.id === selectedId) : undefined;
    const selectedIssue = kind === "issues" ? library?.issues.find((item) => item.id === selectedId) : undefined;
    const filtered = items.filter((item) => `${item.title} ${item.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return <section className="casepick-library" aria-label={kind === "cases" ? "已存案例" : "主问题"}>
        <header className="casepick-section-heading">
            <div><span className="casepick-eyebrow">本地资产库</span><h2>{kind === "cases" ? "已存案例" : "主问题"} <span className="casepick-count">{items.length}</span></h2></div>
            <div className="casepick-actions">
                {kind === "issues" && <Button variant="outline" disabled={!hasSession} onClick={manageIssues}>管理主问题</Button>}
                <Button variant="ghost" disabled={loading} onClick={refresh}>刷新</Button>
            </div>
        </header>
        <div className="casepick-library-search"><Input aria-label="搜索资产" placeholder="搜索标题或 ID…"
            value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <LoadError error={error} />
        {loading && <div className="casepick-loading" role="status"><StateDot state="ongoing" />正在读取资产库…</div>}
        <div className="casepick-library-grid">
            <div className="casepick-library-list" aria-label="资产列表">
                {!loading && !error && filtered.length === 0 && <div className="casepick-empty"><h3>{query ? "没有匹配的资产" : kind === "cases" ? "尚无已存案例" : "尚无主问题"}</h3>
                    <p>{query ? "尝试其他标题或 ID。" : "从会话启动工作流，审阅并保存后将在这里显示。"}</p></div>}
                {filtered.map((item) => <button type="button" key={item.id} className="casepick-list-item"
                    aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)}>
                    <strong>{item.title || item.id}</strong><span className="casepick-hint">{item.id}</span>
                </button>)}
            </div>
            <div className="casepick-library-detail">
                {selected ? <>
                    <span className="casepick-eyebrow">{kind === "cases" ? "已保存的评测案例" : "跨会话主问题"}</span>
                    <h3>{selected.title || selected.id}</h3>
                    <dl className="casepick-metadata"><dt>ID</dt><dd>{selected.id}</dd>
                        {selectedCase && <><dt>创建时间</dt><dd>{dateLabel(selectedCase.createdAt)}</dd></>}
                        {selectedIssue && <><dt>关联会话</dt><dd>{selectedIssue.sessionCount}</dd>
                            <dt>证据</dt><dd>{selectedIssue.evidenceCount}</dd><dt>切片</dt><dd>{selectedIssue.sliceCount}</dd></>}
                    </dl>
                    {selectedIssue && <><p className="casepick-hint">在右侧主问题工作流中选择此 ID，可查看详情、证据、切片并继续编辑。</p>
                        <Button variant="outline" disabled={!hasSession} onClick={manageIssues}>打开主问题管理</Button></>}
                    {selectedIssue && !hasSession && <p className="casepick-hint">在会话审阅中选择一个工作区会话后，可继续主问题工作流。</p>}
                    {detailLoading && <div className="casepick-loading" role="status"><StateDot state="ongoing" />正在读取完整内容…</div>}
                    <LoadError error={detailError} />
                    {detail && <details className="casepick-asset-document" open><summary>完整保存内容</summary>
                        <pre className="casepick-asset-content">{detail.content}</pre>
                    </details>}
                </> : <div className="casepick-empty"><h3>资产详情</h3><p>选择左侧条目查看已保存信息。</p></div>}
            </div>
        </div>
    </section>;
}

export function Workspace({ rpc, navigation, surfaceFor, renderSettings, renderWorkflow }: WorkspaceProps): React.ReactElement {
    const nav = React.useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
    const [sessions, setSessions] = React.useState<WorkspaceSession[]>([]);
    const [sessionError, setSessionError] = React.useState<string>();
    const [sessionsLoading, setSessionsLoading] = React.useState(true);
    const [sessionQuery, setSessionQuery] = React.useState("");
    const [snapshot, setSnapshot] = React.useState<WorkspaceSnapshot>();
    const [snapshotError, setSnapshotError] = React.useState<string>();
    const [snapshotLoading, setSnapshotLoading] = React.useState(false);
    const [cutoff, setCutoff] = React.useState<string>();
    const [library, setLibrary] = React.useState<WorkspaceLibrary>();
    const [libraryError, setLibraryError] = React.useState<string>();
    const [libraryLoading, setLibraryLoading] = React.useState(true);
    const [reload, setReload] = React.useState(0);
    const [snapshotReload, setSnapshotReload] = React.useState(0);
    const refresh = React.useCallback(() => setReload((value) => value + 1), []);
    const refreshSnapshot = React.useCallback(() => setSnapshotReload((value) => value + 1), []);
    const complete = React.useCallback(() => { refresh(); refreshSnapshot(); }, [refresh, refreshSnapshot]);
    React.useEffect(() => {
        const controller = new AbortController();
        setSessionsLoading(true);
        setSessionError(undefined);
        void call<WorkspaceSession[]>(rpc, "sessions/list", {}, controller.signal).then((value) => {
            if (!controller.signal.aborted) setSessions(value);
        }).catch((error: unknown) => {
            if (!controller.signal.aborted) setSessionError(String(error instanceof Error ? error.message : error));
        }).finally(() => { if (!controller.signal.aborted) setSessionsLoading(false); });
        setLibraryLoading(true);
        setLibraryError(undefined);
        void call<WorkspaceLibrary>(rpc, "library", {}, controller.signal).then((value) => {
            if (!controller.signal.aborted) setLibrary(value);
        }).catch((error: unknown) => {
            if (!controller.signal.aborted) setLibraryError(String(error instanceof Error ? error.message : error));
        }).finally(() => { if (!controller.signal.aborted) setLibraryLoading(false); });
        return () => controller.abort();
    }, [rpc, reload]);
    React.useEffect(() => {
        const controller = new AbortController();
        setSnapshot(undefined);
        setSnapshotError(undefined);
        setCutoff(undefined);
        setSnapshotLoading(!!nav.sessionId);
        if (nav.sessionId) {
            void call<WorkspaceSnapshot>(rpc, "sessions/read", { sessionId: nav.sessionId }, controller.signal).then((value) => {
                if (!controller.signal.aborted) setSnapshot(value);
            }).catch((error: unknown) => {
                if (!controller.signal.aborted) setSnapshotError(String(error instanceof Error ? error.message : error));
            }).finally(() => { if (!controller.signal.aborted) setSnapshotLoading(false); });
        }
        return () => controller.abort();
    }, [rpc, nav.sessionId, snapshotReload]);
    const visibleSnapshot = snapshot?.session.id === nav.sessionId ? snapshot : undefined;
    const session = visibleSnapshot?.session ?? sessions.find((item) => item.id === nav.sessionId);
    const surface = nav.sessionId ? surfaceFor(nav.sessionId) : undefined;
    const [running, setRunning] = React.useState(false);
    React.useEffect(() => {
        const update = () => {
            const state = surface?.getSnapshot();
            setRunning(!!state && (state.busy || !!state.view?.runId && !state.view.done));
        };
        update();
        return surface?.subscribe(update);
    }, [surface]);
    const matching = sessions.filter((item) => `${item.title} ${item.cwd} ${item.id}`.toLocaleLowerCase().includes(sessionQuery.toLocaleLowerCase()));
    return <main className="casepick-workspace">
        <header className="casepick-workspace-header">
            <div className="casepick-brand"><span className="casepick-page-mark" aria-hidden="true"><IconChecklistOutlineRegular size={22} /></span>
                <div><h1>CasePick</h1><p>会话审阅与评测资产管理</p></div></div>
            <span className="casepick-workspace-session" title={session?.cwd}>{session ? `工作区会话 · ${session.title || session.id}` : "未选择工作区会话"}</span>
        </header>
        <nav className="casepick-tabs" aria-label="CasePick 导航">
            {([["sessions", "会话审阅"], ["cases", "已存案例"], ["issues", "主问题"], ["settings", "设置"]] as const).map(([tab, label]) =>
                <button type="button" key={tab} aria-current={nav.tab === tab ? "page" : undefined}
                    onClick={() => { navigation.select(tab); if (tab === "cases" || tab === "issues") refresh(); }}>{label}</button>)}
        </nav>
        <div className={`casepick-workspace-grid${surface ? " casepick-has-workflow" : ""}`}>
            <div className="casepick-workspace-content">
                {nav.tab === "sessions" && <div className="casepick-session-grid">
                    <aside className="casepick-session-browser" aria-label="历史会话">
                        <header className="casepick-section-heading"><h2>会话 <span className="casepick-count">{sessions.length}</span></h2>
                            <Button variant="ghost" disabled={sessionsLoading} onClick={refresh}>刷新</Button></header>
                        <div className="casepick-session-search"><Input aria-label="搜索会话" placeholder="搜索标题、路径或 ID…" value={sessionQuery}
                            onChange={(event) => setSessionQuery(event.target.value)} /></div>
                        <p className="casepick-browser-hint">独立选择，不改变当前聊天</p>
                        <div className="casepick-session-list" aria-busy={sessionsLoading}>
                            {sessionsLoading && <div className="casepick-loading" role="status"><StateDot state="ongoing" />正在读取会话…</div>}
                            <LoadError error={sessionError} />
                            {!sessionsLoading && !sessionError && matching.length === 0 && <div className="casepick-empty"><p>{sessionQuery ? "没有匹配的会话。" : "尚无会话记录。"}</p></div>}
                            {matching.map((item) => <button type="button" key={item.id} className="casepick-list-item"
                                aria-pressed={nav.sessionId === item.id} onClick={() => navigation.select("sessions", item.id)}>
                                <strong>{item.title || item.id}</strong><span className="casepick-hint casepick-path" title={item.cwd}>{item.cwd}</span>
                                <span className="casepick-hint">{dateLabel(item.createdAt)}</span>
                            </button>)}
                        </div>
                    </aside>
                    <SessionTimeline key={nav.sessionId ?? "none"} snapshot={visibleSnapshot} loading={snapshotLoading} error={snapshotError}
                        cutoff={cutoff} setCutoff={setCutoff} refresh={refreshSnapshot} running={running}
                        start={(entry) => { if (surface) void surface.open("", entry, visibleSnapshot?.watermark); }} />
                </div>}
                {(nav.tab === "cases" || nav.tab === "issues") && <LibraryPanel key={nav.tab} rpc={rpc} kind={nav.tab}
                    library={library} loading={libraryLoading} error={libraryError} refresh={refresh}
                    manageIssues={() => { if (surface) void surface.open("issues", undefined, visibleSnapshot?.watermark); }} hasSession={!!surface} />}
                {nav.tab === "settings" && renderSettings(session, (sessionId) => { void surfaceFor(sessionId).open("config"); })}
            </div>
            {surface && renderWorkflow(surface, complete)}
        </div>
    </main>;
}
