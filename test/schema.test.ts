import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { TSchema } from "@sinclair/typebox";
import {
  CaseDocument,
  DatasetDocument,
  ScoringDocument,
  schemaErrors,
} from "../src/schema/case.ts";

const fixture = (name: string) => new URL(`./fixtures/detroit/${name}`, import.meta.url);
const readJson = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8"));
const readJsonl = (name: string) =>
  readFileSync(fixture(name), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
const detroitAccepts = ajv.compile(readJson("detroit-v2.schema.json"));

const exampleCase = readJsonl("cases.jsonl")[0];
const exampleScoring = readJsonl("scorings.jsonl")[0];
const exampleDataset = readJson("dataset.json");

const accepts = (schema: TSchema, value: unknown) => schemaErrors(schema, value).length === 0;

// 在 Detroit 示例上做一处修改，得到一个新文档。
function variant<T>(base: T, change: (doc: T) => void): T {
  const doc = structuredClone(base);
  change(doc);
  return doc;
}

describe("Detroit 示例", () => {
  test("案例被 CasePick 和 Detroit 同时接受", () => {
    assert.deepEqual(schemaErrors(CaseDocument, exampleCase), []);
    assert.ok(detroitAccepts(exampleCase));
  });

  test("单独分发的评分被 CasePick 和 Detroit 同时接受", () => {
    assert.deepEqual(schemaErrors(ScoringDocument, exampleScoring), []);
    assert.ok(detroitAccepts(exampleScoring));
  });

  test("评测集被 CasePick 和 Detroit 同时接受", () => {
    assert.deepEqual(schemaErrors(DatasetDocument, exampleDataset), []);
    assert.ok(detroitAccepts(exampleDataset));
  });
});

// CasePick 会产出的各种合法形态。每一种都必须同时被 Detroit 接受。
const validCases: [string, unknown][] = [
  ["Detroit 示例原样", exampleCase],
  [
    "出错消息是一次工具调用",
    variant(exampleCase, (d) => {
      d.diagnostic.observed = {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_9", type: "function", function: { name: "write", arguments: "{\"path\":\"tests/a.ts\"}" } }],
      };
      d.task.output.format = "tool_calls";
      d.scoring.requirements[0].checks = [{ type: "tool_not_called", name: "write", args_match: { path: "tests/a.ts" } }];
    }),
  ],
  [
    "四组约束都用上",
    variant(exampleCase, (d) => {
      d.scoring.requirements[0].checks = [
        { type: "json_only", scope: "final_text" },
        { type: "not_contains", text: "好的", ignore_case: true },
        { type: "not_regex", pattern: "^```", flags: "m" },
        { type: "tool_not_called", name: "write" },
      ];
    }),
  ],
  [
    "只有 rubric 没有约束",
    variant(exampleCase, (d) => {
      delete d.scoring.requirements[0].checks;
      d.task.output.format = "text";
    }),
  ],
  [
    "assistant 消息同时有文字和工具调用",
    variant(exampleCase, (d) => {
      d.task.messages[1].content = "我先读一下文件。";
    }),
  ],
  [
    "需要环境但无法恢复，带脱敏记录和私有扩展",
    variant(exampleCase, (d) => {
      d.task.environment.kind = "unavailable";
      d.task.limitations = [{ field: "task.environment", status: "unrecoverable", note: "扫描时文件已改变" }];
      d.provenance.transforms = [{ type: "redact", target: "task.messages[2]", detail: "api_key" }];
      d.extensions["x-casepick"].host_version = "1.1.0";
      d.extensions["x-casepick"].confirmed_at = "2026-10-12T09:30:00Z";
    }),
  ],
  [
    "验证集用途，没有工具定义",
    variant(exampleCase, (d) => {
      d.provenance.purpose = "validation";
      d.task.tools = { source: "none" };
    }),
  ],
];

describe("CasePick 接受的文档 Detroit 也接受", () => {
  for (const [name, doc] of validCases) {
    test(name, () => {
      assert.deepEqual(schemaErrors(CaseDocument, doc), []);
      assert.ok(detroitAccepts(doc), JSON.stringify(detroitAccepts.errors));
    });
  }
});

// 协议允许、但 CasePick 不产出的形态（技术设计第 7 节"比协议更严格的地方"）。
const stricterThanDetroit: [string, unknown][] = [
  ["要求只有约束、没有 rubric", variant(exampleCase, (d) => { delete d.scoring.requirements[0].rubric; })],
  [
    "rubric 没有取自原出错输出的违反例子",
    variant(exampleCase, (d) => {
      d.scoring.requirements[0].rubric.examples = [{ verdict: "fail", origin: "written", text: "前言：{}" }];
    }),
  ],
  ["要求没有出处", variant(exampleCase, (d) => { delete d.scoring.requirements[0].source; })],
  ["没有 diagnostic", variant(exampleCase, (d) => { delete d.diagnostic; })],
  ["加分项", variant(exampleCase, (d) => { d.scoring.requirements[0].required = false; })],
  ["多步执行的题", variant(exampleCase, (d) => { d.task.horizon = "episode"; d.task.start = "original"; })],
  ["其他生产方的扩展字段", variant(exampleCase, (d) => { d.extensions["x-other"] = {}; })],
];

describe("CasePick 比 Detroit 更严格", () => {
  for (const [name, doc] of stricterThanDetroit) {
    test(name, () => {
      assert.ok(detroitAccepts(doc), `Detroit 应该接受：${JSON.stringify(detroitAccepts.errors)}`);
      assert.equal(accepts(CaseDocument, doc), false);
    });
  }
});

// 两边都必须拒绝的形态。
const invalid: [string, unknown][] = [
  ["顶层未知字段", variant(exampleCase, (d) => { d.quality = "A"; })],
  ["system 消息出现在 messages 里", variant(exampleCase, (d) => { d.task.messages.unshift({ role: "system", content: "x" }); })],
  [
    "assistant 消息既没文字也没工具调用",
    variant(exampleCase, (d) => { d.task.messages[1] = { role: "assistant", content: null }; }),
  ],
  ["已知约束带多余参数", variant(exampleCase, (d) => { d.scoring.requirements[0].checks = [{ type: "json_only", text: "x" }]; })],
  ["摘要格式不对", variant(exampleCase, (d) => { d.digests.task = "md5:abc"; })],
  ["缺评分摘要", variant(exampleCase, (d) => { delete d.digests.scoring; })],
  ["创建时间没有时区", variant(exampleCase, (d) => { d.provenance.created_at = "2026-10-11T14:02:11"; })],
];

describe("两边都拒绝", () => {
  for (const [name, doc] of invalid) {
    test(name, () => {
      assert.equal(accepts(CaseDocument, doc), false);
      assert.equal(detroitAccepts(doc), false);
    });
  }
});

test("schemaErrors 给出出错位置", () => {
  const doc = variant(exampleCase, (d) => { d.title = ""; });
  const errors = schemaErrors(CaseDocument, doc);
  assert.ok(errors.some((e) => e.path === "/title"), JSON.stringify(errors));
});

test("单独分发的评分必须指向一道 CasePick 案例", () => {
  const doc = variant(exampleScoring, (d) => { d.target.case_id = "swe-bench-verified:x"; });
  assert.equal(accepts(ScoringDocument, doc), false);
});
