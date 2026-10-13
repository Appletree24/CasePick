import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { caseDigests } from "../src/core/digest.ts";
import { draftCase, setBasis } from "../src/core/draft-rule.ts";
import {
    addEvidence, duplicateSlices, laterTexts, mergeIssues, newIssue, recordSlice, sliceKeys, splitIssue, timeline, type Evidence,
} from "../src/core/issues.ts";
import { lintCase } from "../src/core/lint.ts";
import { contextSource } from "../src/core/messages.ts";
import { rubricForNorm, norms } from "../src/core/norms.ts";
import { CaseDocument, schemaErrors } from "../src/schema/case.ts";
import { defaultConfig, loadConfig, saveConfig } from "../src/store/config.ts";
import { loadIssues, saveIssue } from "../src/store/issues.ts";
import { contextAt } from "../src/pi/read-session.ts";
import { loadSessionFile, mainBranch, sourceReferences } from "../src/pi/sources.ts";

const directory = await mkdtemp(join(tmpdir(), "casepick-test-"));
after(() => rm(directory, { recursive: true, force: true }));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
const detroitAccepts = ajv.compile(JSON.parse(readFileSync(new URL("./fixtures/detroit/detroit-v2.schema.json", import.meta.url), "utf8")));

const pi = { getActiveTools: () => [], getAllTools: () => [] } as unknown as ExtensionAPI;

function assistant(text: string) {
    return {
        role: "assistant" as const, content: [{ type: "text" as const, text }],
        api: "anthropic-messages" as const, provider: "anthropic", model: "fixture",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop" as const, timestamp: 0,
    };
}

// 写一个 Pi 格式的会话文件：主分支之外还有一条已放弃的分支。
async function writeSession(name: string) {
    const manager = SessionManager.inMemory("/work");
    manager.appendMessage({ role: "user", content: "PC 端按钮可点，APP 端不可点，帮我查原因。", timestamp: 0 });
    const branchPoint = manager.appendMessage(assistant("先看两端数据。"));
    manager.appendMessage({ role: "user", content: "已放弃分支上的话", timestamp: 0 });
    manager.branch(branchPoint);
    manager.appendMessage({ role: "user", content: "生产实例已经和 cac32df 对齐，新代码已全量。", timestamp: 0 });
    const cutoff = manager.appendMessage(assistant("这肯定是旧版本构建产物导致的。"));
    manager.appendMessage({ role: "user", content: "不对，根因是类型转换库不同。", timestamp: 0 });
    manager.appendMessage(assistant("明白，是类型转换库不同导致枚举值变成 0。"));
    const lines = [manager.getHeader(), ...manager.getEntries()].map((item) => JSON.stringify(item));
    const path = join(directory, name);
    await writeFile(path, `${lines.join("\n")}\n`);
    return { path, cutoff, sessionId: manager.getSessionId() };
}

describe("读取其他会话文件", () => {
    test("只读主分支，原文件不变", async () => {
        const { path } = await writeSession("a.jsonl");
        const before = await readFile(path, "utf8");
        const mtime = (await stat(path)).mtimeMs;
        const session = await loadSessionFile(path, pi);
        assert.equal(session.external, true);
        const texts = session.snapshot.messages.map((item) => item.message.content);
        assert.ok(!texts.includes("已放弃分支上的话"));
        assert.equal(texts.length, 6);
        assert.equal(await readFile(path, "utf8"), before);
        assert.equal((await stat(path)).mtimeMs, mtime);
    });

    test("从其他会话的截止点重建输入，后续纠正不进输入", async () => {
        const { path, cutoff } = await writeSession("b.jsonl");
        const session = await loadSessionFile(path, pi);
        const context = contextAt(session.snapshot, cutoff);
        assert.deepEqual(context.input.map((item) => item.message.content), [
            "PC 端按钮可点，APP 端不可点，帮我查原因。", "先看两端数据。", "生产实例已经和 cac32df 对齐，新代码已全量。",
        ]);
        assert.equal(context.observed.content, "这肯定是旧版本构建产物导致的。");
    });

    test("最后一行写到一半时忽略，中间行损坏时报错", async () => {
        const { path } = await writeSession("c.jsonl");
        await writeFile(path, `${await readFile(path, "utf8")}{"type":"mess`);
        await loadSessionFile(path, pi);
        const lines = (await readFile(path, "utf8")).split("\n");
        lines.splice(2, 0, "{bad");
        await writeFile(path, lines.join("\n"));
        await assert.rejects(loadSessionFile(path, pi), /不是合法 JSON/);
    });

    test("主分支沿父链回溯，遇到环也会停止", () => {
        const branch = mainBranch([
            { id: "a", parentId: null, type: "message" }, { id: "b", parentId: "a", type: "message" },
            { id: "x", parentId: "a", type: "message" }, { id: "c", parentId: "b", type: "message" },
        ]);
        assert.deepEqual(branch.map((item) => item.id), ["a", "b", "c"]);
        assert.deepEqual(mainBranch([{ id: "a", parentId: "b", type: "m" }, { id: "b", parentId: "a", type: "m" }]).map((item) => item.id), ["a", "b"]);
    });

    test("汇编消息的来源标记可以在 details 或顶层", () => {
        const refs = sourceReferences({
            sessionKey: "s", messages: [], tools: { source: "none" },
            branch: [
                { type: "custom_message", id: "m1", parentId: null, timestamp: "", customType: "import", display: true, content: "历史回复原文", details: { sourceSessionId: "abc", sourceEntryId: "e9", sourceRole: "assistant" } },
                { type: "custom_message", id: "m2", parentId: "m1", timestamp: "", customType: "import", display: true, content: [{ type: "text", text: "另一条" }], sourceSessionId: "def" },
                { type: "custom_message", id: "m3", parentId: "m2", timestamp: "", customType: "note", display: true, content: "没有来源" },
            ] as never,
        });
        assert.deepEqual(refs.map((ref) => [ref.entry, ref.sessionId, ref.sourceEntry, ref.role]), [["m1", "abc", "e9", "assistant"], ["m2", "def", undefined, undefined]]);
    });
});

function evidence(session: string, entry: string, at: string, excerpt: string): Omit<Evidence, "id"> {
    return { session, entry, role: "user", kind: "user_statement", at, excerpt, content_hash: "h", availability: "original" };
}

describe("主案例", () => {
    test("时间线按原始时间排序，重复证据只记一次", () => {
        const issue = newIssue("书号问题");
        addEvidence(issue, evidence("s2", "e1", "2026-08-25T00:00:00.000Z", "后来"));
        addEvidence(issue, evidence("s1", "e1", "2026-08-21T00:00:00.000Z", "先"));
        assert.equal(addEvidence(issue, evidence("s1", "e1", "2026-08-21T00:00:00.000Z", "先")), undefined);
        assert.deepEqual(timeline(issue).map((item) => item.excerpt), ["先", "后来"]);
    });

    test("截止点之后的证据和结论算作后见之明", () => {
        const issue = newIssue("书号问题");
        addEvidence(issue, evidence("s1", "e1", "2026-08-21T00:00:00.000Z", "早期证据"));
        addEvidence(issue, evidence("s1", "cut", "2026-08-21T01:00:00.000Z", "截止点"));
        addEvidence(issue, evidence("s2", "e9", "2026-10-08T00:00:00.000Z", "用户复述：类型转换库不同"));
        issue.resolution = { statement: "两边类型转换库不同", confidence: "user_reported", unknowns: ["具体库名"] };
        assert.deepEqual(laterTexts(issue, { session: "s1", entry: "cut", at: "" }), ["用户复述：类型转换库不同", "两边类型转换库不同", "具体库名"]);
        // 截止点本身不在时间线里时按时间比较。
        assert.deepEqual(laterTexts(issue, { session: "s1", entry: "other", at: "2026-08-21T00:30:00.000Z" }).slice(0, 2), ["截止点", "用户复述：类型转换库不同"]);
    });

    test("依据和引文相同的切片判为重复", () => {
        const issue = newIssue("书号问题");
        const doc = { scoring: { requirements: [{ id: "r1", source: { message: 0, quote: "新代码已全量" } }] }, extensions: { "x-casepick": { cutoff_entry: "c", requirements: { r1: { basis: "norm", norm: "N2", norms_version: 1 } } } } } as never;
        recordSlice(issue, { case_id: "casepick:a", session: "s1", cutoff_entry: "c1", keys: sliceKeys(doc) });
        assert.equal(duplicateSlices(issue, sliceKeys(doc)).length, 1);
        assert.equal(duplicateSlices(issue, sliceKeys(doc), "casepick:a").length, 0);
        assert.equal(duplicateSlices(issue, ["evidence|-|新代码已全量"]).length, 0);
    });

    test("合并与拆分", () => {
        const a = newIssue("A");
        const b = newIssue("B");
        addEvidence(a, evidence("s1", "e1", "", "一"));
        addEvidence(b, evidence("s2", "e2", "", "二"));
        b.sessions.push({ key: "s2", label: "会话二" });
        mergeIssues(a, b);
        assert.equal(a.evidence.length, 2);
        assert.deepEqual(a.sessions.map((item) => item.key), ["s2"]);
        const created = splitIssue(a, [a.evidence[1].id], "C");
        assert.deepEqual(created.evidence.map((item) => item.excerpt), ["二"]);
        assert.deepEqual(a.evidence.map((item) => item.excerpt), ["一"]);
    });
});

describe("长程切片的 lint", async () => {
    const { path, cutoff } = await writeSession("lint.jsonl");
    const session = await loadSessionFile(path, pi);
    const context = contextAt(session.snapshot, cutoff);

    function slice(change?: (doc: CaseDocument) => void): CaseDocument {
        const doc = draftCase(context, "test");
        doc.title = "用户确认已全量，仍断言旧版本";
        doc.scoring.requirements = [{
            id: "r1", text: "出现反证时撤回旧版本假设", required: true,
            source: { message: 2, quote: "新代码已全量" },
            rubric: { ...rubricForNorm(norms[1]), examples: [{ verdict: "fail", origin: "observed", text: "这肯定是旧版本构建产物导致的" }] },
        }];
        doc.diagnostic.violates = ["r1"];
        setBasis(doc, "r1", { basis: "norm", norm: "N2", norms_version: 1 });
        doc.extensions!["x-casepick"]!.issue_id = "issue_abc";
        doc.provenance.source.group_key = "issue_abc";
        change?.(doc);
        doc.digests = caseDigests(doc);
        return doc;
    }
    const lint = (doc: CaseDocument, laterTexts: string[] = []) => lintCase(doc, { stage: "confirm", source: contextSource(context), laterTexts });

    test("规范依据的切片通过检查，导出后 Detroit 接受", () => {
        const doc = slice();
        const result = lint(doc);
        assert.deepEqual(result.issues.filter((issue) => issue.severity === "error"), []);
        assert.deepEqual(schemaErrors(CaseDocument, doc), []);
        assert.ok(detroitAccepts(doc), JSON.stringify(detroitAccepts.errors));
    });

    test("rubric 用了后来才知道的根因，阻止确认", () => {
        const doc = slice((d) => { d.scoring.requirements[0].rubric.fail = "回复没有指出是类型转换库不同导致的问题。"; });
        const issues = lint(doc).issues.filter((issue) => issue.code === "rubric_hindsight");
        assert.equal(issues.length, 1);
        assert.match(issues[0].path, /rubric\/fail$/);
    });

    test("主案例里更晚的证据也算后见之明", () => {
        const doc = slice((d) => { d.scoring.requirements[0].text = "应当发现两边序列化框架的枚举处理不同"; });
        assert.equal(lint(doc).issues.some((issue) => issue.code === "rubric_hindsight"), false);
        assert.equal(lint(doc, ["后来确认：两边序列化框架的枚举处理不同"]).issues.some((issue) => issue.code === "rubric_hindsight" && issue.path.endsWith("/text")), true);
    });

    test("截止点之前出现过的片段不算后见之明", () => {
        const doc = slice((d) => { d.scoring.requirements[0].rubric.question = "回复是否回应了“生产实例已经和 cac32df 对齐”这一反证？"; });
        assert.equal(lint(doc, ["生产实例已经和 cac32df 对齐，这点后来又说了一次"]).issues.some((issue) => issue.code === "rubric_hindsight"), false);
    });

    test("依据记录要对应真实的要求，规范版本要一致", () => {
        const unknown = slice((d) => { d.extensions!["x-casepick"]!.requirements!.r9 = { basis: "evidence" }; });
        assert.ok(lint(unknown).issues.some((issue) => issue.code === "basis_unknown_requirement"));
        const version = slice((d) => { setBasis(d, "r1", { basis: "norm", norm: "N2", norms_version: 7 }); });
        assert.ok(lint(version).issues.some((issue) => issue.code === "norms_version_unknown"));
    });

    test("evidence 依据不能引用助手自己的回复", () => {
        const doc = slice((d) => {
            d.scoring.requirements[0].source = { message: 1, quote: "先看两端数据" };
            setBasis(d, "r1", { basis: "evidence" });
        });
        assert.ok(lint(doc).issues.some((issue) => issue.code === "basis_source_assistant"));
    });
});

describe("本地存储", () => {
    test("配置文件不存在时用默认值：跟随当前模型、low", async () => {
        const path = join(directory, "config", "config.json");
        assert.deepEqual(await loadConfig(path), defaultConfig());
        assert.deepEqual(defaultConfig().drafting.model, { mode: "follow_current" });
        assert.equal(defaultConfig().drafting.reasoning, "low");
    });

    test("配置保存后权限为 0600，缺失字段用默认值补齐，无效内容报错", async () => {
        const path = join(directory, "config2", "config.json");
        const config = defaultConfig();
        config.drafting.model = { mode: "fixed", provider: "anthropic", id: "claude-x" };
        await saveConfig(config, path);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.deepEqual(await loadConfig(path), config);
        await writeFile(path, JSON.stringify({ drafting: { reasoning: "high" } }));
        assert.equal((await loadConfig(path)).drafting.reasoning, "high");
        await writeFile(path, JSON.stringify({ drafting: { reasoning: "ultra" } }));
        await assert.rejects(loadConfig(path), /配置文件无效/);
    });

    test("主案例按修订追加，读取取最新；另一个窗口改过时拒绝覆盖", async () => {
        const path = join(directory, "issues.jsonl");
        const issue = newIssue("书号问题");
        await saveIssue(issue, path);
        addEvidence(issue, evidence("s1", "e1", "", "证据"));
        await saveIssue(issue, path);
        assert.equal(issue.revision, 2);
        const [loaded] = await loadIssues(path);
        assert.equal(loaded.revision, 2);
        assert.equal(loaded.evidence.length, 1);
        const stale = structuredClone(loaded);
        stale.revision = 1;
        await assert.rejects(saveIssue(stale, path), /另一个窗口/);
        loaded.deleted = true;
        await saveIssue(loaded, path);
        assert.deepEqual(await loadIssues(path), []);
    });
});
