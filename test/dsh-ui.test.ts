import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { WorkflowUI } from "../src/host.ts";
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

class MaintenanceAgent implements Pick<Agent, "ctx" | "runMaintenance"> {
    readonly ctx = new Context();
    readonly controller = new AbortController();
    active = false;
    operation?: Promise<unknown>;

    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.active) throw new Error("agent already has active work");
        this.active = true;
        const operation = task(this.controller.signal).finally(() => { this.active = false; });
        this.operation = operation;
        return operation;
    }
}

test("原生工作流同步保留 maintenance，重复打开不会启动第二项工作", async () => {
    const agent = new MaintenanceAgent();
    const bridge = new DialogBridge("session");
    let calls = 0;
    const initial = bridge.startMaintenance(agent, async (ui) => {
        calls++;
        assert.equal(agent.active, true);
        await ui.confirm("保存", "确认？");
    });
    assert.equal(initial.done, false);
    assert.equal(initial.dialog?.kind, "confirm");
    assert.equal(calls, 1);
    const duplicate = bridge.startMaintenance(agent, async () => { calls++; });
    assert.equal(duplicate.runId, initial.runId);
    assert.equal(calls, 1);
    bridge.answer(initial.runId!, initial.dialog!.id, true);
    await agent.operation;
    assert.equal(agent.active, false);
    assert.equal(bridge.snapshot().done, true);
    bridge.dispose();
});

test("已有 Agent 工作拒绝 maintenance，不执行 CasePick 读取或模型调用", () => {
    const agent = new MaintenanceAgent();
    agent.active = true;
    const bridge = new DialogBridge("busy-session");
    let called = false;
    const view = bridge.startMaintenance(agent, async () => { called = true; });
    assert.equal(called, false);
    assert.equal(view.done, true);
    assert.match(view.notices[0]!.text, /active work/);
    bridge.dispose();
});

test("Agent maintenance 取消同时中止模型信号和待回答对话框", async () => {
    const agent = new MaintenanceAgent();
    const bridge = new DialogBridge("cancel-session");
    let signal: AbortSignal | undefined;
    const initial = bridge.startMaintenance(agent, async (ui, operationSignal) => {
        signal = operationSignal;
        await ui.editor("备注", "");
    });
    const reason = { kind: "user" };
    agent.controller.abort(reason);
    await assert.rejects(agent.operation!, (error) => error === reason);
    assert.equal(signal?.aborted, true);
    assert.equal(signal?.reason, reason);
    assert.equal(bridge.snapshot().runId, undefined);
    assert.equal(bridge.snapshot().dialog, undefined);
    assert.equal(bridge.snapshot().done, true);
    assert.throws(() => bridge.answer(initial.runId!, initial.dialog!.id, "旧答复"), /失效/);
    assert.deepEqual(bridge.snapshot().notices, []);
});

test("关闭界面中止合并信号，旧 maintenance 结束不能覆盖新工作流", async () => {
    const agent = new MaintenanceAgent();
    const bridge = new DialogBridge("session");
    let signal: AbortSignal | undefined;
    const initial = bridge.startMaintenance(agent, async (ui, operationSignal) => {
        signal = operationSignal;
        await ui.confirm("旧保存", "");
    });
    bridge.cancel(initial.runId!);
    assert.equal(signal?.aborted, true);
    assert.equal(agent.controller.signal.aborted, false);
    const next = bridge.begin()!;
    const dialog = next.ui.confirm("新保存", "");
    const currentDialog = bridge.snapshot().dialog!;
    await assert.rejects(agent.operation!, { name: "AbortError" });
    assert.equal(bridge.snapshot().runId, next.id);
    assert.equal(bridge.snapshot().dialog?.id, currentDialog.id);
    bridge.answer(next.id, currentDialog.id, true);
    assert.equal(await dialog, true);
    bridge.dispose();
});

test("已经取消的 maintenance 不执行工作流，并且完成后的旧 UI 不能继续发布", async () => {
    const agent = new MaintenanceAgent();
    agent.controller.abort(new DOMException("已离开", "AbortError"));
    const bridge = new DialogBridge("session");
    let called = false;
    bridge.startMaintenance(agent, async () => { called = true; });
    await assert.rejects(agent.operation!, { name: "AbortError" });
    assert.equal(called, false);
    assert.equal(bridge.snapshot().runId, undefined);
    assert.deepEqual(bridge.snapshot().notices, []);

    let completedUI: WorkflowUI | undefined;
    const nextAgent = new MaintenanceAgent();
    bridge.startMaintenance(nextAgent, async (ui) => { completedUI = ui; });
    await nextAgent.operation;
    const revision = bridge.snapshot().revision;
    completedUI!.notify("迟到的提示");
    completedUI!.setStatus("casepick", "迟到的状态");
    await assert.rejects(completedUI!.confirm("迟到的保存", ""), { name: "AbortError" });
    assert.equal(bridge.snapshot().revision, revision);
    assert.equal(bridge.snapshot().dialog, undefined);
    bridge.dispose();
});
