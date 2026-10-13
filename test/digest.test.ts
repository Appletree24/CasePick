import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  canonicalize,
  caseDigests,
  datasetDigest,
  scoringDigest,
  taskDigest,
} from "../src/core/digest.ts";

const fixture = (name: string) => new URL(`./fixtures/detroit/${name}`, import.meta.url);
const readJson = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8"));
const readJsonl = (name: string) =>
  readFileSync(fixture(name), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const exampleCase = readJsonl("cases.jsonl")[0];
const exampleScoring = readJsonl("scorings.jsonl")[0];
const exampleDataset = readJson("dataset.json");

function variant<T>(base: T, change: (doc: T) => void): T {
  const doc = structuredClone(base);
  change(doc);
  return doc;
}

describe("RFC 8785 规范化", () => {
  test("RFC 8785 §3.2.2 的示例", () => {
    const input = String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}`;
    const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;
    assert.equal(canonicalize(JSON.parse(input)), expected);
  });

  test("键按 UTF-16 码元排序（RFC 8785 §3.2.3）", () => {
    const keys = ["\u20ac", "\r", "\ufb33", "1", "\ud83d\ude00", "\u0080", "\u00f6"];
    const sorted = ["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"];
    const value = Object.fromEntries(keys.map((key) => [key, 0]));
    assert.equal(canonicalize(value), `{${sorted.map((key) => `${JSON.stringify(key)}:0`).join(",")}}`);
  });

  test("数字按 ECMAScript 格式输出", () => {
    assert.equal(canonicalize([-0, 1e21, 1e-7, 0.000001, 100]), "[0,1e+21,1e-7,0.000001,100]");
  });

  test("跳过值为 undefined 的属性", () => {
    assert.equal(canonicalize({ b: undefined, a: 1 }), '{"a":1}');
  });

  test("拒绝 JSON 表示不了的值", () => {
    for (const value of [NaN, Infinity, 1n, "\ud800", { "\udc00": 1 }, [undefined], [, 1], new Date(0), () => 0]) {
      assert.throws(() => canonicalize(value), TypeError);
    }
  });
});

describe("Detroit 示例的摘要", () => {
  test("题目摘要", () => {
    assert.equal(taskDigest(exampleCase.task), exampleCase.digests.task);
  });

  test("内联评分摘要", () => {
    assert.equal(scoringDigest(exampleCase.scoring), exampleCase.digests.scoring);
    assert.deepEqual(caseDigests(exampleCase), exampleCase.digests);
  });

  test("单独分发的评分摘要", () => {
    assert.equal(scoringDigest(exampleScoring), exampleScoring.digests.scoring);
  });

  test("评测集摘要", () => {
    assert.equal(datasetDigest(exampleDataset), exampleDataset.digests.dataset);
  });
});

describe("摘要覆盖范围", () => {
  test("只改 rubric：题目摘要不变，评分摘要改变", () => {
    const doc = variant(exampleCase, (d) => { d.scoring.requirements[0].rubric.question = "回答是否只有 JSON？"; });
    assert.equal(taskDigest(doc.task), exampleCase.digests.task);
    assert.notEqual(scoringDigest(doc.scoring), exampleCase.digests.scoring);
  });

  test("改标题、诊断、来源、扩展和评分的生产方，两个摘要都不变", () => {
    const doc = variant(exampleCase, (d) => {
      d.title = "新标题";
      d.diagnostic.notes = "补充说明";
      d.provenance.purpose = "validation";
      d.extensions["x-casepick"].rubric_edited = true;
      d.scoring.label = "strict";
      d.scoring.producer.method = "manual";
    });
    assert.deepEqual(caseDigests(doc), exampleCase.digests);
  });

  test("内联评分原样单独导出，评分摘要不变", () => {
    const standalone = {
      schema: "detroit.scoring/v2",
      id: `${exampleCase.id}/default`,
      revision: 2,
      target: { case_id: exampleCase.id, task_digest: exampleCase.digests.task },
      ...exampleCase.scoring,
      digests: { scoring: exampleCase.digests.scoring },
    };
    assert.equal(scoringDigest(standalone), exampleCase.digests.scoring);
  });

  test("评测集摘要随用途改变", () => {
    const doc = variant(exampleDataset, (d) => { d.purpose = "validation"; });
    assert.notEqual(datasetDigest(doc), exampleDataset.digests.dataset);
  });
});
