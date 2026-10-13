// /casepick 的参数解析、帮助和补全。纯函数，不依赖 Pi，便于单独测试。

export const subcommands = [
  {
    name: "mark",
    usage: "/casepick mark [备注]",
    description: "在当前位置留一个书签",
  },
  {
    name: "cases",
    usage: "/casepick cases",
    description: "浏览、编辑、删除已有案例",
  },
  {
    name: "export",
    usage: "/casepick export",
    description: "导出已确认的案例",
  },
  {
    name: "config",
    usage: "/casepick config",
    description: "配置起草模型和思考等级（默认跟随当前模型、low）",
  },
  {
    name: "help",
    usage: "/casepick help [子命令]",
    description: "显示帮助",
  },
] as const;

export type Subcommand = (typeof subcommands)[number];
export type SubcommandName = Subcommand["name"];

// 不带子命令的 /casepick 即扫描。
export type Action = "scan" | Exclude<SubcommandName, "help">;

export type ParsedCommand =
  | { kind: "run"; action: Action; args: string[] }
  | { kind: "help"; topic?: SubcommandName }
  | { kind: "error"; message: string };

const helpFlags = new Set(["help", "--help", "-h"]);

function findSubcommand(name: string): Subcommand | undefined {
  return subcommands.find((item) => item.name === name);
}

export function parseCommand(input: string): ParsedCommand {
  const [first, ...rest] = input.trim().split(/\s+/).filter(Boolean);

  if (first === undefined) return { kind: "run", action: "scan", args: [] };

  if (helpFlags.has(first)) {
    if (rest.length === 0) return { kind: "help" };
    const [topic, ...extra] = rest;
    if (helpFlags.has(topic) && extra.length === 0) return { kind: "help" };
    const sub = findSubcommand(topic);
    if (!sub) {
      return { kind: "error", message: `没有名为 ${topic} 的子命令。` };
    }
    if (extra.length > 0) {
      return { kind: "error", message: `多余的参数：${extra.join(" ")}` };
    }
    return { kind: "help", topic: sub.name };
  }

  const sub = findSubcommand(first);
  if (!sub) {
    const message = first.startsWith("-")
      ? `未知选项：${first}`
      : `未知子命令：${first}`;
    return { kind: "error", message };
  }

  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    return { kind: "help", topic: sub.name };
  }

  switch (sub.name) {
    case "help":
      // 前面已处理 help 开头的输入，这里不会到达。
      return { kind: "help" };
    case "mark":
      // 备注是自由文本。
      return { kind: "run", action: "mark", args: rest };
    default:
      if (rest.length > 0) {
        return {
          kind: "error",
          message: `${sub.usage} 不接受参数：${rest.join(" ")}`,
        };
      }
      return { kind: "run", action: sub.name, args: [] };
  }
}

export function helpText(topic?: SubcommandName): string {
  if (topic !== undefined) {
    const sub = findSubcommand(topic)!;
    return `用法：${sub.usage}\n${sub.description}`;
  }
  return [
    "CasePick — 把 Agent 的犯错整理成评测案例",
    "  /casepick — 从当前会话选择回复，起草、审阅并保存案例",
    "  支持本地格式规则、手动填写和模型起草；可以整理跨多个会话的长程问题。",
    ...subcommands.map(({ usage, description }) => `  ${usage} — ${description}`),
    "运行 /casepick help <子命令> 查看单个子命令的说明。",
  ].join("\n");
}

export interface Completion {
  value: string;
  label: string;
  description: string;
}

// 只补全第一个词，已经输入空格后不再补全。
export function completeSubcommand(prefix: string): Completion[] | null {
  if (/\s/.test(prefix)) return null;
  const matches = subcommands
    .filter(({ name }) => name.startsWith(prefix))
    .map(({ name, description }) => ({ value: name, label: name, description }));
  return matches.length > 0 ? matches : null;
}
