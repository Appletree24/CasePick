// 读取用户选定的其他会话文件（docs/long-trajectory-slicing.md §4）。
// 只读：自己解析 JSONL，不经过 SessionManager.open，避免宿主迁移或改写原文件。

import { readFile, stat } from "node:fs/promises";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistEntry } from "../core/assist.ts";
import type { RecordedEntry } from "../core/messages.ts";
import { currentTools, sessionKeyOf, snapshotFromBranch, type SessionSnapshot } from "./read-session.ts";

const fileLimit = 64 * 1024 * 1024;

export interface LoadedSession {
    key: string;
    id: string;
    file?: string;
    label: string;
    snapshot: SessionSnapshot;
    // 不是当前会话时，额外记一条局限。
    external: boolean;
}

export interface SessionChoice {
    path: string;
    id: string;
    cwd: string;
    label: string;
    modified: Date;
}

// 两个宿主的 SessionInfo 共有 path、id、cwd、modified、firstMessage；名字字段不同。
export async function listSessions(): Promise<SessionChoice[]> {
    const infos = await (SessionManager.listAll as () => Promise<{ path: string; id: string; cwd: string; modified: Date; firstMessage?: string; name?: string; title?: string }[]>)();
    return infos.map((info) => ({
        path: info.path, id: info.id, cwd: info.cwd, modified: new Date(info.modified),
        label: info.name || info.title || (info.firstMessage ?? "").replace(/\s+/g, " ").slice(0, 60) || info.id,
    })).sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export function currentSession(ctx: ExtensionCommandContext, snapshot: SessionSnapshot): LoadedSession {
    const id = ctx.sessionManager.getSessionId();
    return {
        key: snapshot.sessionKey, id, file: ctx.sessionManager.getSessionFile(),
        label: `当前会话 ${id.slice(0, 8)}`, snapshot, external: false,
    };
}

interface RawEntry { id: string; parentId?: string | null; type: string; timestamp?: string }

// 主分支：从文件中最后一条带 id 的条目沿父链回溯到根。已放弃的分支不读。
export function mainBranch(entries: readonly RawEntry[]): RawEntry[] {
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch: RawEntry[] = [];
    const seen = new Set<string>();
    let current: RawEntry | undefined = entries.at(-1);
    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        branch.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return branch.reverse();
}

export async function loadSessionFile(path: string, pi: ExtensionAPI): Promise<LoadedSession> {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`不是会话文件：${path}`);
    if (info.size > fileLimit) throw new Error(`会话文件超过 ${fileLimit / 1024 / 1024} MB，未读取：${path}`);
    const lines = (await readFile(path, "utf8")).split("\n");
    let header: { id?: string; cwd?: string } | undefined;
    const entries: RawEntry[] = [];
    lines.forEach((line, index) => {
        if (!line.trim()) return;
        let value: Record<string, unknown>;
        try { value = JSON.parse(line); } catch {
            // 最后一行可能正在被写入；中间行损坏则不能保证分支完整。
            if (index >= lines.length - 2) return;
            throw new Error(`会话文件第 ${index + 1} 行不是合法 JSON：${path}`);
        }
        if (value.type === "session") header = value as typeof header;
        else if (typeof value.id === "string") entries.push(value as unknown as RawEntry);
    });
    const id = header?.id ?? path;
    const branch = mainBranch(entries) as unknown as SessionEntry[];
    const snapshot = await snapshotFromBranch(branch, sessionKeyOf(id), currentTools(pi));
    return { key: snapshot.sessionKey, id, file: path, label: `会话 ${id.slice(0, 8)}${header?.cwd ? ` · ${header.cwd}` : ""}`, snapshot, external: true };
}

// 条目的原始时间；宿主写入的是 ISO 字符串或毫秒数。
export function entryTime(snapshot: SessionSnapshot, entryId: string): string {
    const entry = snapshot.branch.find((item) => item.id === entryId) as { timestamp?: string | number } | undefined;
    if (entry?.timestamp === undefined) return "";
    const date = new Date(entry.timestamp);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function assistEntries(session: LoadedSession, prefix: string): AssistEntry[] {
    return session.snapshot.messages.map((entry: RecordedEntry, index) => ({
        ref: `${prefix}:E${index + 1}`, session: session.key, entry: entry.id, role: entry.message.role,
        at: entryTime(session.snapshot, entry.id), message: entry.message,
    }));
}

export interface SourceReference {
    entry: string;           // 汇编会话里的 custom_message entry
    sessionId: string;
    sourceEntry?: string;
    role?: string;
    preview: string;
}

// 汇编材料：custom_message 带 sourceSessionId / sourceEntryId / sourceRole（可能在 details 里）。
// 它们只用来导航，不能当截止点，也不进任何输入。
export function sourceReferences(snapshot: SessionSnapshot): SourceReference[] {
    const references: SourceReference[] = [];
    for (const entry of snapshot.branch as unknown as Record<string, unknown>[]) {
        if (entry.type !== "custom_message") continue;
        const details = (entry.details ?? {}) as Record<string, unknown>;
        const field = (name: string) => (typeof details[name] === "string" ? details[name] : typeof entry[name] === "string" ? entry[name] : undefined) as string | undefined;
        const sessionId = field("sourceSessionId");
        if (!sessionId) continue;
        const content = entry.content;
        const text = typeof content === "string" ? content
            : Array.isArray(content) ? content.map((block) => (block as { text?: string }).text ?? "").join("") : "";
        references.push({ entry: entry.id as string, sessionId, sourceEntry: field("sourceEntryId"), role: field("sourceRole"), preview: text.replace(/\s+/g, " ").slice(0, 80) });
    }
    return references;
}

export async function findSessionFile(sessionId: string): Promise<string | undefined> {
    return (await listSessions()).find((session) => session.id === sessionId)?.path;
}
