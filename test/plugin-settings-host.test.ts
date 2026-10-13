import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
            stdout = await new Promise<string>((resolve, reject) => {
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
                    // 取得结果即结束隔离宿主，不进入会话或调用模型；不在扩展内 process.exit。
                    if (/CASEPICK_(SETTINGS|ERROR)=.*\n/.test(output)) child.kill("SIGKILL");
                });
                child.stderr.on("data", (chunk) => { errors += chunk; });
                child.on("error", reject);
                child.on("close", () => resolve(`${output}\n${errors}`));
            });
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
