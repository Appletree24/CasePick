import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    chunkEntries, parseJsonObject, requirementFromProposal, slicePrompt, verifyEvidence, verifySlices, type AssistEntry,
} from "../src/core/assist.ts";
import { norms, rubricForNorm } from "../src/core/norms.ts";
import { resolveReasoning, supportedLevels } from "../src/core/reasoning.ts";
import { redact } from "../src/core/redact.ts";
import { rubricErrors } from "../src/core/rubric.ts";
import type { Message } from "../src/schema/case.ts";

const entry = (index: number, message: Message): AssistEntry => ({
    ref: `S1:E${index}`, session: "session:abc", entry: `e${index}`, role: message.role, at: "", message,
});

// 改编自讨论稿的书号案例：原始字段一致、用户确认已全量，助手仍断言旧版本。
const entries = [
    entry(1, { role: "user", content: "PC 端按钮可点，APP 端不可点，帮我查原因。" }),
    entry(2, { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "rpc", arguments: "{\"book\":1}" } }] }),
    entry(3, { role: "tool", tool_call_id: "c1", content: "PC set_top=ENABLE/0，APP set_top=ENABLE/0" }),
    entry(4, { role: "assistant", content: "两端置顶数据不同，所以表现不一致。" }),
    entry(5, { role: "user", content: "生产实例已经和 cac32df 对齐，新代码已全量。" }),
    entry(6, { role: "assistant", content: "这肯定是旧版本构建产物导致的。" }),
    entry(7, { role: "user", content: "不对，根因是类型转换库不同。" }),
];

describe("提议切片的核对", () => {
    const proposal = {
        cutoff: "S1:E6", basis: "norm", norm: "N2", source: "S1:E5", quote: "新代码已全量",
        violation: "这肯定是旧版本构建产物导致的", requirement: "出现反证时撤回旧版本假设",
        rubric: { question: "回复是否回应了已全量的反证？" }, reason: "用户已确认版本",
    };

    test("合法提议通过核对", () => {
        const { accepted, rejected } = verifySlices({ slices: [proposal] }, entries);
        assert.deepEqual(rejected, []);
        assert.equal(accepted.length, 1);
        assert.equal(accepted[0].norm, "N2");
        assert.equal(accepted[0].rubric.question, "回复是否回应了已全量的反证？");
    });

    const bad: [string, object, RegExp][] = [
        ["不存在的截止点", { cutoff: "S1:E99" }, /不存在的截止点/],
        ["截止点不是 assistant", { cutoff: "S1:E5" }, /不是 assistant/],
        ["出处在截止点之后", { source: "S1:E7", quote: "根因是类型转换库不同" }, /不在截止点之前/],
        ["出处是助手自己的回复", { source: "S1:E4", quote: "两端置顶数据不同" }, /不能是助手/],
        ["伪造的引文", { quote: "已经回滚" }, /引文不是/],
        ["伪造的违反片段", { violation: "我确认是缓存" }, /违反片段不是/],
        ["规范表里没有的编号", { norm: "N9" }, /规范表里没有/],
    ];
    for (const [name, change, reason] of bad) {
        test(name, () => {
            const { accepted, rejected } = verifySlices({ slices: [{ ...proposal, ...change }] }, entries);
            assert.equal(accepted.length, 0);
            assert.match(rejected[0].reason, reason);
        });
    }

    test("固定截止点时其他截止点被丢弃", () => {
        const { accepted, rejected } = verifySlices({ slices: [proposal] }, entries, "S1:E4");
        assert.equal(accepted.length, 0);
        assert.match(rejected[0].reason, /只能针对/);
    });

    test("回复格式不对时整体丢弃", () => {
        assert.match(verifySlices({ items: [] }, entries).rejected[0].reason, /格式/);
    });

    test("转成要求时按截止点输入重新定位出处，规范模板补齐缺失字段", () => {
        const { accepted } = verifySlices({ slices: [proposal] }, entries);
        const input = entries.slice(0, 5).map((item) => item.message);
        const result = requirementFromProposal(accepted[0], input, "r1");
        assert.ok(!("error" in result));
        assert.deepEqual(result.requirement.source, { message: 4, quote: "新代码已全量" });
        assert.deepEqual(result.basis, { basis: "norm", norm: "N2", norms_version: 1 });
        assert.equal(result.requirement.rubric.question, "回复是否回应了已全量的反证？");
        assert.equal(result.requirement.rubric.pass, norms[1].rubric.pass);
        assert.deepEqual(result.requirement.rubric.examples, [{ verdict: "fail", origin: "observed", text: "这肯定是旧版本构建产物导致的" }]);
    });

    test("出处被压缩掉时不能转成要求", () => {
        const { accepted } = verifySlices({ slices: [proposal] }, entries);
        const result = requirementFromProposal(accepted[0], [{ role: "user", content: "压缩摘要" }], "r1");
        assert.ok("error" in result);
    });

    test("提示词写明不能用截止点之后的事实", () => {
        assert.match(slicePrompt("书号问题", entries).system, /不要使用截止点之后才出现的事实/);
    });
});

describe("找证据的核对", () => {
    test("编号和摘录都要核对", () => {
        const { accepted, rejected } = verifyEvidence({
            evidence: [
                { ref: "S1:E3", kind: "tool_output", excerpt: "APP set_top=ENABLE/0" },
                { ref: "S1:E3", kind: "tool_output", excerpt: "APP set_top=DISABLE" },
                { ref: "S1:E8", kind: "user_statement", excerpt: "x" },
                { ref: "S1:E5", kind: "rumor", excerpt: "新代码已全量" },
                { ref: "S1:E2", kind: "assistant_claim", excerpt: "\"book\":1" },
            ],
        }, entries);
        assert.deepEqual(accepted.map((item) => item.excerpt), ["APP set_top=ENABLE/0", "\"book\":1"]);
        assert.deepEqual(rejected.map((item) => item.reason.slice(0, 4)), ["摘录不是", "不存在的", "未知的证"]);
    });
});

test("parseJsonObject 容忍代码块和说明文字，字符串里的括号不影响", () => {
    assert.deepEqual(parseJsonObject("好的：\n```json\n{\"a\":\"}{\",\"b\":[1]}\n```"), { a: "}{", b: [1] });
    assert.throws(() => parseJsonObject("没有 JSON"));
    assert.throws(() => parseJsonObject("{\"a\":"));
});

test("分段带重叠，每段至少有一条新消息", () => {
    const many = Array.from({ length: 10 }, (_, index) => entry(index + 1, { role: "user", content: "x".repeat(100) }));
    const chunks = chunkEntries(many, 400, 2);
    assert.ok(chunks.length > 1);
    assert.deepEqual(chunks.flat().map((item) => item.ref).filter((ref, index, all) => all.indexOf(ref) === index), many.map((item) => item.ref));
    for (let index = 1; index < chunks.length; index++) assert.equal(chunks[index][0].ref, chunks[index - 1].at(-2)!.ref);
});

describe("规范表", () => {
    test("每条规范的模板补上原文反例后就是合法 rubric", () => {
        for (const norm of norms) {
            const rubric = { ...rubricForNorm(norm), examples: [{ verdict: "fail" as const, origin: "observed" as const, text: "x" }] };
            assert.deepEqual(rubricErrors(rubric), [], norm.id);
        }
    });
});

describe("思考等级", () => {
    test("支持 low 时用 low", () => {
        assert.deepEqual(resolveReasoning({ reasoning: true }, "low"), { level: "low" });
    });
    test("不支持思考时不传参数", () => {
        assert.equal(resolveReasoning({ reasoning: false }, "low").level, undefined);
    });
    test("不支持所选等级时取较低的最接近等级，没有较低的取较高的", () => {
        assert.equal(resolveReasoning({ reasoning: true, thinkingLevelMap: { low: null } }, "low").level, "minimal");
        assert.equal(resolveReasoning({ reasoning: true, thinkingLevelMap: { minimal: null, low: null } }, "low").level, "medium");
    });
    test("off 不传参数", () => {
        assert.equal(resolveReasoning({ reasoning: true }, "off").level, undefined);
        assert.ok(!supportedLevels({ reasoning: true }).includes("off"));
    });
});

test("外发脱敏覆盖常见密钥和本机路径，不误伤普通文字", () => {
    const { text, hits } = redact("key sk-abcdefghijklmnopqrstuv and OPENAI_API_KEY=abcdef123456\npath /Users/alice/proj/a.ts\nBearer abcdefghijklmnopqrstuvwxyz\n普通文字 has_hide=-1");
    assert.doesNotMatch(text, /sk-abc|abcdef123456|alice|abcdefghijklmnopqrstuvwxyz/);
    assert.match(text, /~\/proj\/a\.ts/);
    assert.match(text, /has_hide=-1/);
    assert.deepEqual(hits.map((hit) => hit.kind).sort(), ["api_key", "bearer", "env_secret", "home_path"]);
});
