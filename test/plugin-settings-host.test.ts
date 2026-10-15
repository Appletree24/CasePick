import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

async function runHostProbe(directory: string, extension: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = spawn("omp", ["--cwd", directory, "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-session", "--mode", "rpc", "--extension", extension], {
            cwd: directory,
            env: { ...process.env, HOME: join(directory, "home"), PWD: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), OMP_PROFILE: "" },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 20_000,
            killSignal: "SIGKILL",
        });
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk) => {
            output += chunk;
            if (/CASEPICK_(SETTINGS|SESSION|ERROR)=.*\n/.test(output)) child.kill("SIGKILL");
        });
        child.stderr.on("data", (chunk) => { errors += chunk; });
        child.on("error", reject);
        child.on("close", () => resolve(`${output}\n${errors}`));
    });
}

test("OMP 实际加载插件设置，项目覆盖全局且重新读取能看到修改", { timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "casepick-plugin-host-"));
    try {
        await mkdir(join(directory, ".omp"));
        await mkdir(join(directory, "home"));
        const extension = join(directory, "probe.ts");
        const settingsModule = "./" + relative(directory, fileURLToPath(new URL("../src/pi/plugin-settings.ts", import.meta.url)));
        await writeFile(extension, `
import assert from "node:assert/strict";
import { getPluginsLockfile } from "@oh-my-pi/pi-utils";
import { loadPluginSettings } from ${JSON.stringify(settingsModule)};
export default async function () {
    try {
        const lock = getPluginsLockfile();
        assert.ok(lock.startsWith(${JSON.stringify(directory + "/")}));
        const cwd = ${JSON.stringify(directory)};
        const globalSettings = { draftModel: "acme/global", reasoning: "high", maxOutputTokens: 4000, debug: true };
        const writeGlobal = () => Bun.write(lock, JSON.stringify({ settings: { casepick: globalSettings } }));
        await writeGlobal();
        const results = [await loadPluginSettings(cwd, true)];
        await Bun.write(${JSON.stringify(join(directory, ".omp", "plugin-overrides.json"))}, JSON.stringify({ settings: { casepick: { draftModel: "acme/project", timeoutSeconds: 90, debug: false } } }));
        results.push(await loadPluginSettings(cwd, true));
        globalSettings.maxOutputTokens = 6000;
        await writeGlobal();
        results.push(await loadPluginSettings(cwd, true));
        process.stdout.write("CASEPICK_SETTINGS=" + JSON.stringify(results) + "\\n");
    } catch (error) {
        process.stdout.write("CASEPICK_ERROR=" + String(error) + "\\n");
    }
}
`);
        let stdout: string;
        try {
            stdout = await runHostProbe(directory, extension);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("未安装 OMP；需要真实宿主验证模块加载边界"); return; }
            throw error;
        }
        const result = stdout.split("\n").find((line) => line.startsWith("CASEPICK_SETTINGS="));
        assert.ok(result, stdout);
        assert.deepEqual(JSON.parse(result.slice("CASEPICK_SETTINGS=".length)), [
            { overrides: { model: "acme/global", reasoning: "high", maxOutputTokens: 4000, debug: true }, warnings: [], available: true },
            { overrides: { model: "acme/project", reasoning: "high", maxOutputTokens: 4000, timeoutSeconds: 90, debug: false }, warnings: [], available: true },
            { overrides: { model: "acme/project", reasoning: "high", maxOutputTokens: 6000, timeoutSeconds: 90, debug: false }, warnings: [], available: true },
        ], stdout);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("OMP 原生 SDK 保留 developer 指令，未来纠正和压缩不泄漏到历史截止点", { timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "casepick-session-host-"));
    try {
        await mkdir(join(directory, "home"));
        const extension = join(directory, "probe.ts");
        const sessionModule = "./" + relative(directory, fileURLToPath(new URL("../src/pi/read-session.ts", import.meta.url)));
        await writeFile(extension, `
import { buildSessionContext, convertToLlm, SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { readSession, contextAt } from ${JSON.stringify(sessionModule)};
export default async function () {
    try {
        const manager = SessionManager.inMemory(${JSON.stringify(directory)});
        const assistant = (text) => ({
            role: "assistant", content: [{ type: "text", text }],
            api: "openai-responses", provider: "openai", model: "fixture",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop", timestamp: 0,
        });
        manager.appendMessage({ role: "developer", content: "不得添加解释文字。", timestamp: 0 });
        manager.appendMessage({ role: "user", content: "只输出 JSON", timestamp: 0 });
        const cutoff = manager.appendMessage(assistant("好的，{}"));
        const correction = manager.appendMessage({ role: "user", content: "未来纠正", timestamp: 0 });
        manager.appendMessage(assistant("{}"));
        manager.appendCompaction("未来摘要", correction, 100);
        const snapshot = await readSession({
            sessionManager: manager, piSdk: { buildSessionContext, convertToLlm, SessionManager, VERSION },
        }, { getActiveTools: () => [], getAllTools: () => [] });
        const context = contextAt(snapshot, cutoff);
        process.stdout.write("CASEPICK_SESSION=" + JSON.stringify({
            system: context.system, input: context.input.map((entry) => entry.message),
            observed: context.observed, followup: context.followup,
        }) + "\\n");
    } catch (error) {
        process.stdout.write("CASEPICK_ERROR=" + String(error) + "\\n");
    }
}
`);
        let stdout: string;
        try {
            stdout = await runHostProbe(directory, extension);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") { t.skip("未安装 OMP；需要真实宿主验证历史上下文"); return; }
            throw error;
        }
        const result = stdout.split("\n").find((line) => line.startsWith("CASEPICK_SESSION="));
        assert.ok(result, stdout);
        assert.deepEqual(JSON.parse(result.slice("CASEPICK_SESSION=".length)), {
            system: { status: "approximate", content: "不得添加解释文字。" },
            input: [{ role: "user", content: "只输出 JSON" }],
            observed: { role: "assistant", content: "好的，{}" },
            followup: [{ role: "user", content: "未来纠正" }],
        });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
