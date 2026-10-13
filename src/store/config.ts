// config.json：起草模型选择和思考等级（技术设计第 8 节③）。不保存任何密钥。

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Static, Type } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";
import { reasoningLevels } from "../core/reasoning.ts";
import { dataDir } from "./cases.ts";

export const ModelChoice = Type.Union([
    Type.Object({ mode: Type.Literal("follow_current") }, { additionalProperties: false }),
    Type.Object({ mode: Type.Literal("fixed"), provider: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    Type.Object({ mode: Type.Literal("off") }, { additionalProperties: false }),
]);

export const Config = Type.Object({
    drafting: Type.Object({
        model: ModelChoice,
        reasoning: Type.Union(reasoningLevels.map((level) => Type.Literal(level))),
        max_output_tokens: Type.Integer({ minimum: 256, maximum: 200_000 }),
        timeout_s: Type.Integer({ minimum: 10, maximum: 3600 }),
        debug: Type.Boolean(),
        // 已看过完整示例请求并同意外发的模型（provider/id）。
        consented: Type.Array(Type.String()),
    }, { additionalProperties: false }),
}, { additionalProperties: false });

export type ModelChoice = Static<typeof ModelChoice>;
export type Config = Static<typeof Config>;

export function defaultConfig(): Config {
    return { drafting: { model: { mode: "follow_current" }, reasoning: "low", max_output_tokens: 8000, timeout_s: 120, debug: false, consented: [] } };
}

export function configPath(): string {
    return join(dataDir(), "config.json");
}

// 文件不存在时返回默认值；内容无效时报错，不悄悄覆盖用户的配置。
export async function loadConfig(path = configPath()): Promise<Config> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
        throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
        throw new Error(`配置文件不是合法 JSON：${path}`);
    }
    // 缺失的字段用默认值补齐，方便以后新增配置项。
    const defaults = defaultConfig();
    const merged = { drafting: { ...defaults.drafting, ...((parsed as { drafting?: object })?.drafting ?? {}) } };
    if (!Value.Check(Config, merged)) {
        const first = [...Value.Errors(Config, merged)][0];
        throw new Error(`配置文件无效（${first?.path ?? "/"}：${first?.message ?? "格式错误"}）：${path}`);
    }
    return merged;
}

export async function saveConfig(config: Config, path = configPath()): Promise<void> {
    if (!Value.Check(Config, config)) throw new Error("配置无效，未保存");
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
}
