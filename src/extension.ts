import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    type Action,
    completeSubcommand,
    helpText,
    parseCommand,
} from "./command.ts";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<CommandOptions["handler"]>[1];
type Handler = (args: string[], ctx: CommandContext) => Promise<void>;

function notImplemented(label: string): Handler {
    return async (_args, ctx) => {
        ctx.ui.notify(
            `${label}尚未实现；本次未读取会话、调用模型或读写案例文件。`,
            "warning",
        );
    };
}

const handlers: Record<Action, Handler> = {
    scan: notImplemented("扫描"),
    mark: notImplemented("书签"),
    cases: notImplemented("案例管理"),
    export: notImplemented("导出"),
    config: notImplemented("配置"),
};

export default function casepick(pi: ExtensionAPI): void {
    pi.registerCommand("casepick", {
        description: "把 Agent 的犯错整理成评测案例",
        getArgumentCompletions: completeSubcommand,
        async handler(args, ctx) {
            if (!ctx.hasUI) {
                throw new Error(
                    "CasePick 需要交互 UI；请在 Pi 交互模式中运行 /casepick。",
                );
            }

            const parsed = parseCommand(args);
            switch (parsed.kind) {
                case "help":
                    ctx.ui.notify(helpText(parsed.topic), "info");
                    return;
                case "error":
                    ctx.ui.notify(
                        `${parsed.message}\n运行 /casepick help 查看用法。`,
                        "error",
                    );
                    return;
                case "run":
                    await handlers[parsed.action](parsed.args, ctx);
                    return;
            }
        },
    });
}
