// issues.jsonl：主案例的全部修订，一行一份完整快照，只追加；读取时每个 ID 取最新修订。
// 只在本地使用，不导出。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { Issue } from "../core/issues.ts";
import { appendLine, dataDir } from "./cases.ts";

export function issuesPath(): string {
    return join(dataDir(), "issues.jsonl");
}

async function loadAllRevisions(path: string): Promise<Map<string, number>> {
    const revisions = new Map<string, number>();
    for (const issue of await loadLatest(path, true)) revisions.set(issue.id, issue.revision);
    return revisions;
}

export async function loadIssues(path = issuesPath()): Promise<Issue[]> {
    return loadLatest(path, false);
}

async function loadLatest(path: string, includeDeleted: boolean): Promise<Issue[]> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const latest = new Map<string, Issue>();
    text.split("\n").forEach((line, index) => {
        if (!line.trim()) return;
        let value: unknown;
        try { value = JSON.parse(line); } catch {
            throw new Error(`主案例库第 ${index + 1} 行不是合法 JSON：${path}`);
        }
        if (!Value.Check(Issue, value)) throw new Error(`主案例库第 ${index + 1} 行格式无效：${path}`);
        const previous = latest.get(value.id);
        if (!previous || value.revision >= previous.revision) latest.set(value.id, value);
    });
    return [...latest.values()].filter((issue) => includeDeleted || !issue.deleted)
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
}

// 保存一份新修订，修订号为库中最新修订加 1；调用方传入的对象会被更新 revision 和 updated_at。
// 库中已有比手上更新的修订时拒绝保存，避免覆盖另一个窗口的修改。
export async function saveIssue(issue: Issue, path = issuesPath()): Promise<void> {
    const stored = (await loadAllRevisions(path)).get(issue.id) ?? 0;
    if (stored > issue.revision) throw new Error("这个主案例已在另一个窗口修改过，请重新打开后再编辑");
    const next = { ...structuredClone(issue), revision: stored + 1, updated_at: new Date().toISOString() };
    if (!Value.Check(Issue, next)) throw new Error("主案例格式无效，未保存");
    await appendLine(path, next, "主案例库");
    issue.revision = next.revision;
    issue.updated_at = next.updated_at;
}
