import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const commands = [
  { name: "help", description: "显示命令帮助" },
  { name: "scan", description: "扫描当前活动分支" },
  { name: "generate", description: "从候选生成草稿" },
  { name: "review", description: "审阅与确认草稿" },
  { name: "cases", description: "管理本地案例" },
  { name: "export", description: "预览并导出案例" },
  { name: "config", description: "配置独立生成模型" },
  { name: "delete", description: "删除本地案例" },
] as const;

const help = [
  "CasePick — 命令入口",
  "用法：/casepick <子命令>；/casepick <子命令> --help 查看说明。",
  "当前仅提供命令入口；扫描、生成、案例管理和导出业务尚未实现。",
  ...commands.map(
    ({ name, description }) =>
      `  ${name} — ${description}${name === "help" ? "" : "（尚未实现）"}`,
  ),
].join("\n");

export default function casepick(pi: ExtensionAPI): void {
  pi.registerCommand("casepick", {
    description: "CasePick 命令入口与帮助（尚未接入业务能力）",
    getArgumentCompletions(prefix) {
      const matches = commands
        .filter(({ name }) => name.startsWith(prefix))
        .map(({ name, description }) => ({
          value: name,
          label: name,
          description,
        }));
      return matches.length > 0 ? matches : null;
    },
    async handler(args, ctx) {
      if (!ctx.hasUI) {
        throw new Error(
          "CasePick 命令入口需要交互 UI；请在 Pi 交互模式中运行 /casepick。",
        );
      }

      const [name = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (
        (name === "help" || name === "--help" || name === "-h") &&
        rest.length === 0
      ) {
        ctx.ui.notify(help, "info");
        return;
      }

      const command = commands.find((item) => item.name === name);
      if (!command) {
        ctx.ui.notify(
          `未知子命令：${name}。运行 /casepick help 查看可用入口。`,
          "error",
        );
        return;
      }
      if (
        rest.length > 0 &&
        !(rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h"))
      ) {
        ctx.ui.notify(
          `不支持这些参数。用法：/casepick ${name} [--help]`,
          "error",
        );
        return;
      }
      if (command.name === "help") {
        ctx.ui.notify(help, "info");
        return;
      }

      ctx.ui.notify(
        `/casepick ${command.name} — ${command.description}\n此业务能力尚未实现；本次未读取会话、调用模型或读写案例文件。`,
        "warning",
      );
    },
  });
}
