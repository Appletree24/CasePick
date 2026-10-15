import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = new URL("../lib/dsh/", import.meta.url);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
    absWorkingDir: root, entryPoints: ["src/dsh/index.ts"], outfile: "lib/dsh/index.js",
    bundle: true, packages: "external", platform: "node", format: "esm", target: "node22",
});

const browser = await build({
    absWorkingDir: root, entryPoints: ["src/dsh/client.tsx"], write: false,
    bundle: true, platform: "browser", format: "cjs", target: "es2022", jsx: "automatic",
    external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
});
// DSH serves a module-table factory, not a standalone ESM/CJS browser script.
await writeFile(new URL("client.js", out), `window.__ModuleLoader__.load({id:"casepick",factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n${browser.outputFiles[0].text}\nreturn module.exports;\n}});\n`);
console.log("Built DSH host and browser entries in lib/dsh/");
