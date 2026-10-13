// OMP 设置 → Plugins 分区里的 CasePick 配置（package.json 的 omp.settings）。
// 只有通过 `omp plugin link` / `omp plugin install` 装成插件时才有；Pi 上没有，读不到就当作未设置。
// 填了值的项覆盖 /casepick config 的对应项，留空的项沿用 /casepick config。

import { reasoningLevels, type ReasoningLevel } from "../core/reasoning.ts";

export const pluginName = "casepick";

export interface PluginOverrides {
    // 空表示未设置。可以是 current、off、@角色、provider/id 或宿主能识别的模型名。
    model?: string;
    reasoning?: ReasoningLevel;
    maxOutputTokens?: number;
    timeoutSeconds?: number;
}

export interface PluginSettingsResult {
    overrides: PluginOverrides;
    // OMP 上读取失败或值不合法时的说明；Pi 上为空。
    warnings: string[];
    available: boolean;
}

export type SettingsLoader = (name: string, cwd: string) => Promise<Record<string, unknown>>;

// OMP 的兼容加载器把 @oh-my-pi/* 的子路径映射到宿主自带的包；Pi 上这个导入会失败。
async function hostLoader(): Promise<SettingsLoader | undefined> {
    const specifier = "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
    try {
        const module = await import(specifier) as { getPluginSettings?: SettingsLoader };
        return typeof module.getPluginSettings === "function" ? module.getPluginSettings : undefined;
    } catch {
        return undefined;
    }
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
    const number = typeof value === "string" && value.trim() ? Number(value) : value;
    return typeof number === "number" && Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}

export function parseOverrides(raw: Record<string, unknown>): { overrides: PluginOverrides; warnings: string[] } {
    const overrides: PluginOverrides = {};
    const warnings: string[] = [];
    const set = (key: string) => raw[key] !== undefined && raw[key] !== null && raw[key] !== "";
    if (set("draftModel")) {
        if (typeof raw.draftModel === "string" && raw.draftModel.trim()) overrides.model = raw.draftModel.trim();
        else warnings.push("draftModel 应为文字，已忽略");
    }
    if (set("reasoning")) {
        if ((reasoningLevels as readonly unknown[]).includes(raw.reasoning)) overrides.reasoning = raw.reasoning as ReasoningLevel;
        else warnings.push(`reasoning 不是有效的思考等级：${String(raw.reasoning)}，已忽略`);
    }
    if (set("maxOutputTokens")) {
        overrides.maxOutputTokens = numberIn(raw.maxOutputTokens, 256, 200_000);
        if (overrides.maxOutputTokens === undefined) warnings.push("maxOutputTokens 应为 256–200000 的整数，已忽略");
    }
    if (set("timeoutSeconds")) {
        overrides.timeoutSeconds = numberIn(raw.timeoutSeconds, 10, 3600);
        if (overrides.timeoutSeconds === undefined) warnings.push("timeoutSeconds 应为 10–3600 的整数，已忽略");
    }
    for (const key of Object.keys(overrides) as (keyof PluginOverrides)[]) if (overrides[key] === undefined) delete overrides[key];
    return { overrides, warnings };
}

// isOmp 用来区分“Pi 上本来就没有”与“OMP 上读取失败”，后者要提示。
export async function loadPluginSettings(cwd: string, isOmp: boolean, loader?: SettingsLoader): Promise<PluginSettingsResult> {
    const load = loader ?? await hostLoader();
    if (!load) {
        return { overrides: {}, warnings: isOmp ? ["无法读取 OMP 插件设置，Plugins 分区里的 CasePick 配置不会生效"] : [], available: false };
    }
    try {
        return { ...parseOverrides(await load(pluginName, cwd)), available: true };
    } catch (error) {
        return { overrides: {}, warnings: [`读取 OMP 插件设置失败：${error instanceof Error ? error.message : String(error)}`], available: false };
    }
}
