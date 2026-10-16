import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSettingsPatch, settingError } from "../src/dsh/settings-patch.ts";

test("左侧栏页面的部分更新只写入提交的字段", () => {
    assert.deepEqual(parseSettingsPatch({ debug: true }), { debug: true });
    assert.deepEqual(parseSettingsPatch({ draftModel: "  acme/model  ", reasoning: "high" }), { draftModel: "acme/model", reasoning: "high" });
    assert.deepEqual(parseSettingsPatch({ maxOutputTokens: 8000, timeoutSeconds: 120 }), { maxOutputTokens: 8000, timeoutSeconds: 120 });
});

test("留空表示沿用 /casepick config", () => {
    assert.deepEqual(parseSettingsPatch({ draftModel: "", reasoning: "", maxOutputTokens: null, timeoutSeconds: null }),
        { draftModel: "", reasoning: "", maxOutputTokens: null, timeoutSeconds: null });
    assert.deepEqual(parseSettingsPatch({ draftModel: "   " }), { draftModel: "" });
});

test("范围边界与 Config 一致，只接受整数", () => {
    assert.deepEqual(parseSettingsPatch({ maxOutputTokens: 256, timeoutSeconds: 3600 }), { maxOutputTokens: 256, timeoutSeconds: 3600 });
    assert.deepEqual(parseSettingsPatch({ maxOutputTokens: 200_000, timeoutSeconds: 10 }), { maxOutputTokens: 200_000, timeoutSeconds: 10 });
    for (const maxOutputTokens of [255, 200_001, 1000.5, Number.NaN, "8000", Number.POSITIVE_INFINITY]) {
        assert.throws(() => parseSettingsPatch({ maxOutputTokens }), /单次输出上限应为 256–200000 的整数/);
    }
    for (const timeoutSeconds of [9, 3601, 12.5, "120"]) {
        assert.throws(() => parseSettingsPatch({ timeoutSeconds }), /单次超时（秒）应为 10–3600 的整数/);
    }
});

test("任一字段不合法时整体拒绝，不做部分写入", () => {
    assert.throws(() => parseSettingsPatch({ debug: true, reasoning: "extreme" }), /思考等级不是有效的思考等级：extreme/);
    assert.throws(() => parseSettingsPatch({ debug: "true" }), /调试模式必须是开或关/);
    assert.throws(() => parseSettingsPatch({ draftModel: 42 }), /起草模型必须是文字/);
    assert.throws(() => parseSettingsPatch({ debug: true, consented: [] }), /未知的设置项 consented/);
    assert.throws(() => parseSettingsPatch({}), /没有要保存的设置/);
    assert.throws(() => parseSettingsPatch(null), /设置必须是对象/);
    assert.throws(() => parseSettingsPatch([true]), /设置必须是对象/);
});

test("页面与宿主共用同一字段校验", () => {
    assert.equal(settingError("reasoning", "max"), undefined);
    assert.equal(settingError("maxOutputTokens", null), undefined);
    assert.match(settingError("timeoutSeconds", 5) ?? "", /10–3600/);
});
