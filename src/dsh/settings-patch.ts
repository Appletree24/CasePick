// DSH 原生 CasePick 设置的校验。宿主写入前与左侧栏页面共用，纯函数。
import { reasoningLevels } from "../core/reasoning.ts";
import type { NativeSettings } from "./protocol.ts";

export const settingKeys = ["debug", "draftModel", "reasoning", "maxOutputTokens", "timeoutSeconds"] as const;
export type SettingKey = (typeof settingKeys)[number];

export const settingLabels: Record<SettingKey, string> = {
    debug: "调试模式",
    draftModel: "起草模型",
    reasoning: "思考等级",
    maxOutputTokens: "单次输出上限",
    timeoutSeconds: "单次超时（秒）",
};

// 与 Config 的 min/max 一致；null 表示沿用 /casepick config。
export const settingRanges = { maxOutputTokens: [256, 200_000], timeoutSeconds: [10, 3600] } as const;

export function settingError(key: SettingKey, value: unknown): string | undefined {
    if (key === "debug") return typeof value === "boolean" ? undefined : "必须是开或关";
    if (key === "draftModel") return typeof value === "string" ? undefined : "必须是文字";
    if (key === "reasoning") {
        return value === "" || (reasoningLevels as readonly unknown[]).includes(value) ? undefined : `不是有效的思考等级：${String(value)}`;
    }
    if (value === null) return undefined;
    const [min, max] = settingRanges[key];
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
        ? undefined
        : `应为 ${min}–${max} 的整数，留空沿用 /casepick config`;
}

// 只接受已知字段的部分更新；任何一项不合法都整体拒绝，不做部分写入。
export function parseSettingsPatch(input: unknown): Partial<NativeSettings> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("设置必须是对象");
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (!(settingKeys as readonly string[]).includes(key)) throw new TypeError(`未知的设置项 ${key}`);
        const error = settingError(key as SettingKey, value);
        if (error) throw new TypeError(`${settingLabels[key as SettingKey]}${error}`);
        patch[key] = key === "draftModel" ? (value as string).trim() : value;
    }
    if (!Object.keys(patch).length) throw new TypeError("没有要保存的设置");
    return patch as Partial<NativeSettings>;
}
