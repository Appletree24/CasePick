import { buildSessionContext, convertToLlm, SessionManager, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { configure } from "./pi/config-ui.ts";
import { generateCases } from "./pi/generate.ts";
import type { WorkflowContext } from "./host.ts";
import {
    type Action,
    completeSubcommand,
    helpText,
    parseCommand,
} from "./command.ts";

const piSdk = { buildSessionContext, convertToLlm, SessionManager, VERSION };

type Handler = (args: string[], ctx: WorkflowContext) => Promise<void>;

function notImplemented(label: string): Handler {
    return async (_args, ctx) => {
        ctx.ui.notify(
            `${label}尚未实现；本次未读取会话、调用模型或读写案例文件。`,
            "warning",
        );
    };
}

export default function casepick(pi: ExtensionAPI): void {
    const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    let generating = false;
    const handlers: Record<Action, Handler> = {
        scan: async (_args, ctx) => {
            if (generating) {
                ctx.ui.notify("已有一个案例审阅窗口，请先完成或退出。", "warning");
                return;
            }
            generating = true;
            try {
                await generateCases(pi, ctx, version);
            } finally {
                generating = false;
            }
        },
        mark: notImplemented("书签"),
        cases: notImplemented("案例管理"),
        export: notImplemented("导出"),
        config: async (_args, ctx) => configure(ctx),
    };
    pi.registerCommand("casepick", {
        description: "把 Agent 的犯错整理成评测案例",
        getArgumentCompletions: completeSubcommand,
        async handler(args, ctx) {
            if (!ctx.hasUI) {
                throw new Error(
                    "CasePick 需要交互 UI；请在 Pi 或 OMP 交互模式中运行 /casepick。",
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
                    try {
                        // Keep SDK bindings in the extension entry, where OMP resolves its aliases.
                        const host: WorkflowContext = ctx;
                        const workflow: WorkflowContext = {
                            cwd: ctx.cwd, hasUI: ctx.hasUI, isIdle: () => ctx.isIdle(),
                            ui: ctx.ui, modelRegistry: ctx.modelRegistry,
                            get model() { return ctx.model; },
                            get models() { return host.models; },
                            sessionManager: ctx.sessionManager, piSdk,
                        };
                        await handlers[parsed.action](parsed.args, workflow);
                    } catch (error) {
                        ctx.ui.notify(`CasePick 未完成：${error instanceof Error ? error.message : String(error)}`, "error");
                    }
                    return;
            }
        },
    });
}
