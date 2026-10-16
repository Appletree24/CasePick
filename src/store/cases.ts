import { chmod, mkdir, open, readFile, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { CaseDocument } from "../schema/case.ts";

export function dataDir(): string {
    const dataHome = process.env.XDG_DATA_HOME;
    return join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share"), "casepick");
}

export function casesPath(): string {
    return join(dataDir(), "cases.jsonl");
}

// Read the same append-only documents written by confirmed reviews; latest revision wins.
export async function loadCases(path = casesPath()): Promise<CaseDocument[]> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
    }
    const latest = new Map<string, CaseDocument>();
    text.split("\n").forEach((line, index) => {
        if (!line.trim()) return;
        let value: unknown;
        try { value = JSON.parse(line); } catch {
            throw new Error(`案例库第 ${index + 1} 行不是合法 JSON：${path}`);
        }
        if (!Value.Check(CaseDocument, value)) throw new Error(`案例库第 ${index + 1} 行格式无效：${path}`);
        const previous = latest.get(value.id);
        if (!previous || value.revision >= previous.revision) latest.set(value.id, value);
    });
    return [...latest.values()].sort((a, b) => b.provenance.created_at.localeCompare(a.provenance.created_at));
}

// 调用方已完成审阅和 confirm lint。只追加已确认案例，不存储原始会话快照。
export async function appendCase(doc: CaseDocument, path = casesPath()): Promise<void> {
    if (!doc.extensions?.["x-casepick"]?.confirmed_at) throw new Error("案例尚未确认，不能保存");
    await appendLine(path, doc, "案例库");
}

// 追加一行 JSON：目录 0700、文件 0600，用锁目录避免多窗口交错，写失败时截回原长度。
export async function appendLine(path: string, value: unknown, label: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lock = `${path}.lock`;
    try {
        await mkdir(lock, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${label}正在被另一个窗口写入，请稍后重试。若上次写入异常退出，请检查锁目录：${lock}`);
        throw error;
    }
    try {
        const file = await open(path, "a+", 0o600);
        try {
            await file.chmod(0o600);
            const { size } = await file.stat();
            if (size > 0) {
                const last = Buffer.alloc(1);
                await file.read(last, 0, 1, size - 1);
                if (last[0] !== 10) throw new Error(`${label}末尾存在不完整记录，请先处理，未追加新内容`);
            }
            try {
                await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
                await file.sync();
            } catch (error) {
                await file.truncate(size);
                throw error;
            }
        } finally {
            await file.close();
        }
    } finally {
        await rmdir(lock);
    }
}
