// /casepick config：选择起草模型和思考等级（技术设计第 12 节）。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { reasoningLevels, resolveReasoning, supportedLevels, type ReasoningLevel } from "../core/reasoning.ts";
import { configPath, loadConfig, saveConfig, type Config } from "../store/config.ts";
import { modelKey, modelRole, resolveDraftModel, roleModel } from "./model.ts";
import { loadPluginSettings } from "./plugin-settings.ts";
import { pick, showText } from "./ui.ts";

const roleHelp = `OMP 支持自定义模型角色。声明一次 ${modelRole} 角色后，就能在 /model 面板里像给 @slow 指派模型一样给它选模型：

1. 在 ~/.omp/agent/config.yml 里加上：

modelTags:
  ${modelRole}:
    name: CasePick

2. 打开 /model，在角色列表里找到 CasePick，选一个模型。

之后起草模型设为“跟随当前模型”（默认）时，CasePick 优先使用这个角色的模型；没有指派时才跟随当前会话的模型。

另一种方式：把 CasePick 装成 OMP 插件（omp plugin link <CasePick 目录>），然后在 OMP 设置 → Plugins → casepick 里填 draftModel、reasoning 等。那里填了值的项会覆盖这里的配置；draftModel 是文本框，可以填 @casepick、provider/id、current 或 off。
思考等级仍在这里配置（默认 low），角色值里的思考后缀不会被读取。
Pi 没有模型角色，这一项只在 OMP 里生效。`;

function describeModel(ctx: ExtensionCommandContext, config: Config): string {
    const choice = config.drafting.model;
    if (choice.mode === "off") return "不使用模型";
    if (choice.mode === "follow_current") {
        const role = roleModel(ctx);
        if (role) return `OMP 角色 @${modelRole}（现在是 ${(role as { name?: string }).name || role.id}）`;
        const current = ctx.model as Model<Api> | undefined;
        return `跟随当前模型（现在是 ${current ? (current as { name?: string }).name || current.id : "未选择"}）`;
    }
    return `${choice.provider}/${choice.id}`;
}

// 思考等级按所选模型的能力列出；跟随当前模型时按当前模型列出。
function targetModel(ctx: ExtensionCommandContext, config: Config): Model<Api> | undefined {
    const choice = config.drafting.model;
    if (choice.mode === "follow_current") return roleModel(ctx) ?? ctx.model as Model<Api> | undefined;
    if (choice.mode === "fixed") return ctx.modelRegistry.find(choice.provider, choice.id);
    return undefined;
}

async function chooseModel(ctx: ExtensionCommandContext, config: Config): Promise<boolean> {
    const top = await ctx.ui.select("起草模型", ["跟随当前模型（默认；OMP 里配置了 @casepick 角色时优先用它）", "选择一个已配置的模型", "不使用模型（只用规则和手填）", "在 OMP 的 /model 面板里指定", "返回"]);
    if (!top || top === "返回") return false;
    if (top.startsWith("在 OMP")) {
        await showText(ctx.ui, "在 OMP 的 /model 面板里指定起草模型", roleHelp);
        return false;
    }
    if (top.startsWith("跟随")) config.drafting.model = { mode: "follow_current" };
    else if (top.startsWith("不使用")) config.drafting.model = { mode: "off" };
    else {
        const available = ctx.modelRegistry.getAvailable() as Model<Api>[];
        if (!available.length) {
            ctx.ui.notify("宿主里没有已配置凭据的模型。", "warning");
            return false;
        }
        const sorted = [...available].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
        const model = await pick(ctx.ui, "选择起草模型（按 provider 排序）", sorted,
            (item) => `${item.provider} / ${(item as { name?: string }).name || item.id}${item.reasoning ? "" : "（不支持思考等级）"}`);
        if (!model) return false;
        config.drafting.model = { mode: "fixed", provider: model.provider, id: model.id };
    }
    return true;
}

async function chooseReasoning(ctx: ExtensionCommandContext, config: Config): Promise<boolean> {
    const model = targetModel(ctx, config);
    const levels: ReasoningLevel[] = model ? ["off", ...supportedLevels(model)] : [...reasoningLevels];
    if (model && levels.length === 1) {
        ctx.ui.notify("当前选择的模型不支持思考等级，起草时不会传这个参数。", "info");
        return false;
    }
    const labels = levels.map((level) => `${level}${level === "low" ? "（默认）" : ""}${level === config.drafting.reasoning ? " ← 当前" : ""}`);
    const choice = await ctx.ui.select("思考等级", [...labels, "返回"]);
    if (!choice || choice === "返回") return false;
    config.drafting.reasoning = levels[labels.indexOf(choice)];
    return true;
}

export async function configure(ctx: ExtensionCommandContext): Promise<void> {
    const config = await loadConfig();
    while (true) {
        // 每轮重新读取，用户可能刚在 OMP 设置的 Plugins 分区里改过。
        const plugin = await loadPluginSettings(ctx.cwd, "models" in ctx);
        const overridden = Object.entries(plugin.overrides).map(([key, value]) => `${key}=${value}`);
        const pluginNote = overridden.length ? `\nOMP 设置 → Plugins → casepick 覆盖了：${overridden.join("，")}（这些项以 Plugins 分区为准）`
            : plugin.warnings.length ? `\n${plugin.warnings.join("\n")}` : "";
        const model = targetModel(ctx, config);
        const reasoning = model ? resolveReasoning(model, config.drafting.reasoning) : { level: config.drafting.reasoning };
        const resolved = resolveDraftModel(ctx, config, plugin.overrides);
        const status = resolved.ok ? `起草时实际使用：${resolved.value.label}${resolved.value.note ? `（${resolved.value.note}）` : ""}` : resolved.reason;
        const choice = await ctx.ui.select(`CasePick 配置\n${status}${pluginNote}\n配置文件：${configPath()}`, [
            `起草模型      ${describeModel(ctx, config)}`,
            `思考等级      ${config.drafting.reasoning}${reasoning.level !== config.drafting.reasoning && config.drafting.reasoning !== "off" ? `（实际 ${reasoning.level ?? "不传"}）` : ""}`,
            `已同意外发的模型 ${config.drafting.consented.length} 个（选择以清空）`,
            "完成",
        ]);
        if (!choice || choice === "完成") return;
        let changed = false;
        if (choice.startsWith("起草模型")) changed = await chooseModel(ctx, config);
        else if (choice.startsWith("思考等级")) changed = await chooseReasoning(ctx, config);
        else if (config.drafting.consented.length && await ctx.ui.confirm("清空外发同意", "之后向每个模型第一次发送前，都会重新展示完整示例请求。")) {
            config.drafting.consented = [];
            changed = true;
        }
        if (changed) {
            await saveConfig(config);
            ctx.ui.notify("已保存配置。", "info");
        }
    }
}
