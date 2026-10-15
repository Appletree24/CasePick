import assert from "node:assert/strict";
import { test } from "node:test";
import { DialogBridge } from "../src/dsh/ui-bridge.ts";

test("旧对话框或旧工作流不能确认新的保存操作", async () => {
    const bridge = new DialogBridge("session");
    const first = bridge.begin()!;
    const oldPrompt = first.ui.confirm("保存 A", "确认？");
    const oldDialog = bridge.snapshot().dialog!;
    bridge.answer(first.id, oldDialog.id, false);
    assert.equal(await oldPrompt, false);
    const nextPrompt = first.ui.confirm("保存 B", "确认？");
    const nextDialog = bridge.snapshot().dialog!;
    assert.throws(() => bridge.answer(first.id, oldDialog.id, true), /失效/);
    assert.equal(bridge.snapshot().dialog?.id, nextDialog.id);
    bridge.answer(first.id, nextDialog.id, true);
    assert.equal(await nextPrompt, true);
    bridge.finish(first.id);
    const second = bridge.begin()!;
    const current = second.ui.confirm("保存 C", "确认？");
    const currentDialog = bridge.snapshot().dialog!;
    assert.throws(() => bridge.answer(first.id, currentDialog.id, true), /失效/);
    bridge.finish(first.id, new Error("旧工作流错误"));
    assert.equal(bridge.snapshot().runId, second.id);
    assert.equal(bridge.snapshot().done, false);
    bridge.answer(second.id, currentDialog.id, false);
    assert.equal(await current, false);
    bridge.dispose();
});

test("编辑器保留空提交与取消的区别，关闭会中止待完成操作", async () => {
    const bridge = new DialogBridge("session");
    const run = bridge.begin()!;
    const empty = run.ui.editor("可选备注", "原备注");
    bridge.answer(run.id, bridge.snapshot().dialog!.id, "");
    assert.equal(await empty, "");
    const cancelled = run.ui.editor("可选备注", "原备注");
    bridge.answer(run.id, bridge.snapshot().dialog!.id, null);
    assert.equal(await cancelled, undefined);
    const pending = run.ui.editor("尚未提交", "文字");
    const rejected = assert.rejects(pending, { name: "AbortError" });
    bridge.cancel(run.id);
    await rejected;
    assert.equal(run.signal.aborted, true);
    assert.equal(bridge.snapshot().runId, undefined);
    assert.equal(bridge.snapshot().dialog, undefined);
    await assert.rejects(run.ui.editor("旧窗口", ""), { name: "AbortError" });
});

test("服务端拒绝不属于选项的回答，读取等待可以取消", async () => {
    const bridge = new DialogBridge("session");
    const run = bridge.begin()!;
    const selection = run.ui.select("选择", ["确认", "取消"]);
    const dialog = bridge.snapshot().dialog!;
    assert.throws(() => bridge.answer(run.id, dialog.id, "任意命令"), /选项/);
    assert.equal(bridge.snapshot().dialog?.id, dialog.id);
    const abort = new AbortController();
    const waiting = bridge.wait(bridge.snapshot().revision, abort.signal);
    abort.abort(new DOMException("离开会话", "AbortError"));
    await assert.rejects(waiting, { name: "AbortError" });
    bridge.answer(run.id, dialog.id, "取消");
    assert.equal(await selection, "取消");
    bridge.dispose();
});
