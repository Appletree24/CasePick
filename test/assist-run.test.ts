import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkflowContext } from "../src/host.ts";
import { defaultConfig, saveConfig } from "../src/store/config.ts";
import { proposeEvidence } from "../src/pi/assist-run.ts";
import type { AssistEntry } from "../src/core/assist.ts";

test("valid JSON at an output-token cutoff cannot become accepted evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "casepick-incomplete-"));
    const previous = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = directory;
    try {
        const config = defaultConfig();
        config.drafting.consented = ["fixture/plain"];
        await saveConfig(config);
        let stopReason = "stop";
        const model = { provider: "fixture", id: "plain", name: "Fixture", reasoning: false };
        const quote = "不得改动配置";
        const entries: AssistEntry[] = [{ ref: "S1:E1", session: "s1", entry: "e1", role: "user", at: "", message: { role: "user", content: quote } }];
        // Fixture supplies only capabilities used by the public assistance workflow.
        const ctx = {
            cwd: directory, hasUI: true, isIdle: () => true, model,
            pluginSettings: async () => ({ overrides: {}, warnings: [], available: true }),
            modelRegistry: {
                getAvailable: () => [model], find: () => model, hasConfiguredAuth: () => true,
                streamSimple: () => ({ result: async () => ({ role: "assistant", stopReason,
                    content: [{ type: "text", text: JSON.stringify({ evidence: [{ ref: "S1:E1", kind: "user_statement", excerpt: quote }] }) }],
                    usage: { input: 10, output: 10 },
                }) }),
            },
            ui: { select: async (_title: string, options: string[]) => options.includes("发送") ? "发送" : undefined,
                confirm: async () => true, notify: () => {}, setStatus: () => {},
            },
        } as unknown as WorkflowContext;
        const completed = await proposeEvidence(ctx, "文件范围", entries);
        assert.deepEqual(completed?.map((item) => item.excerpt), [quote]);
        stopReason = "length";
        assert.equal(await proposeEvidence(ctx, "文件范围", entries), undefined);
    } finally {
        if (previous === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = previous;
        await rm(directory, { recursive: true, force: true });
    }
});
