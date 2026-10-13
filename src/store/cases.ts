import { chmod, mkdir, open, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { CaseDocument } from "../schema/case.ts";

export function casesPath(): string {
    const dataHome = process.env.XDG_DATA_HOME;
    return join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share"), "casepick", "cases.jsonl");
}

// 调用方已完成审阅和 confirm lint。只追加已确认案例，不存储原始会话快照。
export async function appendCase(doc: CaseDocument, path = casesPath()): Promise<void> {
    if (!doc.extensions?.["x-casepick"]?.confirmed_at) throw new Error("案例尚未确认，不能保存");
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const lock = `${path}.lock`;
    try {
        await mkdir(lock, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`案例库正在被另一个窗口写入，请稍后重试。若上次写入异常退出，请检查锁目录：${lock}`);
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
                if (last[0] !== 10) throw new Error("案例库末尾存在不完整记录，请先处理，未追加新案例");
            }
            try {
                await file.writeFile(`${JSON.stringify(doc)}\n`, "utf8");
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
