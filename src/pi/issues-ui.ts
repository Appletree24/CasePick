// “整理长程问题”入口（docs/long-trajectory-slicing.md §9）。
// 主案例和证据只存本地；切片走普通案例的审阅和保存流程。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { messagePreview } from "../core/candidates.ts";
import { digestOf } from "../core/digest.ts";
import {
    addEvidence, addSession, evidenceKindLabels, mergeIssues, newIssue, recordSlice, sliceKeys, splitIssue, timeline,
    type Evidence, type EvidenceKind, type Issue,
} from "../core/issues.ts";
import type { Message } from "../schema/case.ts";
import { entryTexts } from "../core/assist.ts";
import { appendCase, casesPath } from "../store/cases.ts";
import { loadIssues, saveIssue } from "../store/issues.ts";
import { proposeEvidence, proposeSlices } from "./assist-run.ts";
import { sessionKeyOf, type SessionSnapshot } from "./read-session.ts";
import { applyProposals, buildSlice } from "./slice.ts";
import {
    assistEntries, currentSession, entryTime, findSessionFile, listSessions, loadSessionFile, sourceReferences,
    type LoadedSession,
} from "./sources.ts";
import { pick, promptEditor, reviewCase, showText } from "./ui.ts";

interface Workspace {
    pi: ExtensionAPI;
    ctx: ExtensionCommandContext;
    version: string;
    current: LoadedSession;
    loaded: Map<string, LoadedSession>;
}

const defaultKind: Record<Message["role"], EvidenceKind> = { user: "user_statement", assistant: "assistant_claim", tool: "tool_output" };

async function save(ws: Workspace, issue: Issue): Promise<boolean> {
    try {
        await saveIssue(issue);
        return true;
    } catch (error) {
        ws.ctx.ui.notify(`主案例没有保存：${error instanceof Error ? error.message : String(error)}`, "error");
        return false;
    }
}

async function text(ws: Workspace, title: string, prefill = "", required = true): Promise<string | undefined> {
    while (true) {
        const value = await promptEditor(ws.ctx.ui, title, prefill);
        if (value === undefined) return undefined;
        if (!required || value.trim()) return value;
        ws.ctx.ui.notify("请填写内容，或按取消返回。", "warning");
    }
}

// 主案例里登记的会话按需打开；文件不在了就只能用已有摘录。
async function sessionOf(ws: Workspace, key: string, issue: Issue): Promise<LoadedSession | undefined> {
    const cached = ws.loaded.get(key);
    if (cached) return cached;
    const record = issue.sessions.find((session) => session.key === key);
    if (!record?.file) return undefined;
    try {
        const loaded = await loadSessionFile(record.file, ws.pi);
        ws.loaded.set(key, loaded);
        return loaded;
    } catch (error) {
        ws.ctx.ui.notify(`打不开会话文件 ${record.file}：${error instanceof Error ? error.message : String(error)}`, "warning");
        return undefined;
    }
}

async function openSessions(ws: Workspace, issue: Issue): Promise<LoadedSession[]> {
    const sessions: LoadedSession[] = [];
    for (const record of issue.sessions) {
        const session = await sessionOf(ws, record.key, issue);
        if (session) sessions.push(session);
    }
    return sessions;
}

async function chooseSession(ws: Workspace, issue: Issue, title: string): Promise<LoadedSession | undefined> {
    const sessions = await openSessions(ws, issue);
    if (!sessions.length) {
        ws.ctx.ui.notify("这个主案例还没有能打开的会话，请先添加会话。", "warning");
        return undefined;
    }
    return sessions.length === 1 ? sessions[0] : pick(ws.ctx.ui, title, sessions, (session) => `${session.label}（${session.snapshot.messages.length} 条消息）`);
}

async function addOtherSession(ws: Workspace, issue: Issue): Promise<LoadedSession | undefined> {
    const how = await ws.ctx.ui.select("添加哪个会话？（只读打开，不修改原文件）", ["从会话列表选择", "输入会话文件路径", "返回"]);
    if (!how || how === "返回") return undefined;
    let path: string | undefined;
    if (how === "从会话列表选择") {
        ws.ctx.ui.setStatus("casepick", "CasePick：正在列出会话…");
        let sessions;
        try { sessions = await listSessions(); } finally { ws.ctx.ui.setStatus("casepick", undefined); }
        const chosen = await pick(ws.ctx.ui, "选择会话（最近修改的在前）", sessions.filter((item) => item.id !== ws.current.id),
            (item) => `${item.modified.toISOString().slice(0, 16)} ${item.label} · ${item.cwd}`);
        path = chosen?.path;
    } else {
        path = (await text(ws, "会话文件的完整路径（.jsonl）"))?.trim();
    }
    if (!path) return undefined;
    try {
        const session = await loadSessionFile(path, ws.pi);
        ws.loaded.set(session.key, session);
        if (addSession(issue, { key: session.key, file: path, label: session.label })) await save(ws, issue);
        ws.ctx.ui.notify(`已添加 ${session.label}，主分支 ${session.snapshot.messages.length} 条消息。`, "info");
        return session;
    } catch (error) {
        ws.ctx.ui.notify(`读取失败：${error instanceof Error ? error.message : String(error)}`, "error");
        return undefined;
    }
}

function evidenceFrom(session: LoadedSession, entryId: string, message: Message, excerpt: string, kind: EvidenceKind, note?: string): Omit<Evidence, "id"> {
    return {
        session: session.key, entry: entryId, role: message.role, kind, at: entryTime(session.snapshot, entryId),
        excerpt, content_hash: digestOf(message), availability: "original", ...(note ? { note } : {}),
    };
}

async function chooseExcerpt(ws: Workspace, message: Message, prefill?: string): Promise<string | undefined> {
    const texts = entryTexts(message).filter((item) => item.trim());
    if (!texts.length) {
        ws.ctx.ui.notify("这条消息没有可摘录的文字。", "warning");
        return undefined;
    }
    const original = texts.length === 1 ? texts[0] : await pick(ws.ctx.ui, "从哪部分摘录？", texts, (item) => item.replace(/\s+/g, " ").slice(0, 90));
    if (original === undefined) return undefined;
    while (true) {
        const excerpt = await text(ws, "证据摘录：只保留原文片段，不要改写", prefill ?? original);
        if (excerpt === undefined) return undefined;
        if (original.includes(excerpt)) return excerpt;
        ws.ctx.ui.notify("摘录必须是所选消息的连续原文片段。", "error");
    }
}

async function chooseKind(ws: Workspace, role: Message["role"], current?: EvidenceKind): Promise<EvidenceKind | undefined> {
    const kinds = Object.keys(evidenceKindLabels) as EvidenceKind[];
    const preferred = current ?? defaultKind[role];
    const ordered = [preferred, ...kinds.filter((kind) => kind !== preferred)];
    const labels = ordered.map((kind) => evidenceKindLabels[kind]);
    const choice = await ws.ctx.ui.select("这条证据的性质", labels);
    return choice ? ordered[labels.indexOf(choice)] : undefined;
}

async function addEvidenceManually(ws: Workspace, issue: Issue): Promise<void> {
    const session = await chooseSession(ws, issue, "从哪个会话添加证据？");
    if (!session) return;
    const entries = session.snapshot.messages.map((entry, index) => ({ entry, index }));
    const chosen = await pick(ws.ctx.ui, "选择消息（最近的在前）", [...entries].reverse(),
        ({ entry, index }) => `#${index + 1} ${entry.message.role} ${entryTime(session.snapshot, entry.id).slice(0, 16)} ${messagePreview(entry.message)}`);
    if (!chosen) return;
    const excerpt = await chooseExcerpt(ws, chosen.entry.message);
    if (excerpt === undefined) return;
    const kind = await chooseKind(ws, chosen.entry.message.role);
    if (!kind) return;
    const note = await text(ws, "备注（可留空）", "", false);
    if (note === undefined) return;
    if (!addEvidence(issue, evidenceFrom(session, chosen.entry.id, chosen.entry.message, excerpt, kind, note.trim() || undefined))) {
        ws.ctx.ui.notify("这段证据已经记录过。", "info");
        return;
    }
    await save(ws, issue);
}

async function addEvidenceWithModel(ws: Workspace, issue: Issue): Promise<void> {
    const sessions = await openSessions(ws, issue);
    if (!sessions.length) { ws.ctx.ui.notify("请先添加会话。", "warning"); return; }
    const entries = sessions.flatMap((session, index) => assistEntries(session, `S${index + 1}`));
    const proposals = await proposeEvidence(ws.ctx, issue.title, entries);
    if (!proposals?.length) return;
    const how = await ws.ctx.ui.select(`模型找到 ${proposals.length} 条证据（已核对编号和原文）`, ["逐条确认", "全部加入", "放弃"]);
    if (!how || how === "放弃") return;
    let added = 0;
    for (const proposal of proposals) {
        const session = sessions.find((item) => item.key === proposal.entry.session)!;
        let kind: EvidenceKind | undefined = proposal.kind;
        if (how === "逐条确认") {
            const choice = await ws.ctx.ui.select(`${evidenceKindLabels[proposal.kind]} · ${proposal.entry.ref}\n${proposal.excerpt.slice(0, 400)}\n理由：${proposal.reason}`,
                ["加入", "改性质后加入", "跳过", "停止"]);
            if (!choice || choice === "停止") break;
            if (choice === "跳过") continue;
            if (choice === "改性质后加入") kind = await chooseKind(ws, proposal.entry.role, proposal.kind);
            if (!kind) continue;
        }
        if (addEvidence(issue, evidenceFrom(session, proposal.entry.entry, proposal.entry.message, proposal.excerpt, kind, `模型标注：${proposal.reason}`))) added++;
    }
    if (added) await save(ws, issue);
    ws.ctx.ui.notify(`加入了 ${added} 条证据。`, "info");
}

// 汇编消息只用来导航：回到原会话找原文，找不到时只能记成摘录。
async function traceAssembled(ws: Workspace, issue: Issue): Promise<void> {
    const sessions = await openSessions(ws, issue);
    const references = sessions.flatMap((session) => sourceReferences(session.snapshot).map((reference) => ({ session, reference })));
    if (!references.length) {
        ws.ctx.ui.notify("已打开的会话里没有带来源标记（sourceSessionId）的汇编消息。", "info");
        return;
    }
    const chosen = await pick(ws.ctx.ui, "选择汇编消息，回到原会话", references,
        ({ reference }) => `${reference.role ?? "?"} ← ${reference.sessionId.slice(0, 8)} ${reference.preview}`);
    if (!chosen) return;
    const { reference } = chosen;
    const key = sessionKeyOf(reference.sessionId);
    let original = ws.loaded.get(key);
    if (!original) {
        const path = await findSessionFile(reference.sessionId);
        if (path) {
            try {
                original = await loadSessionFile(path, ws.pi);
                ws.loaded.set(key, original);
                addSession(issue, { key, file: path, label: original.label });
            } catch (error) {
                ws.ctx.ui.notify(`原会话打不开：${error instanceof Error ? error.message : String(error)}`, "warning");
            }
        }
    }
    const entry = original && reference.sourceEntry ? original.snapshot.messages.find((item) => item.id === reference.sourceEntry) : undefined;
    if (original && entry) {
        ws.ctx.ui.notify(`已找到原会话 ${original.label} 中的原消息。`, "info");
        const excerpt = await chooseExcerpt(ws, entry.message);
        if (excerpt === undefined) { await save(ws, issue); return; }
        const kind = await chooseKind(ws, entry.message.role);
        if (kind && addEvidence(issue, evidenceFrom(original, entry.id, entry.message, excerpt, kind))) ws.ctx.ui.notify("已加入证据（原文）。", "info");
        await save(ws, issue);
        return;
    }
    const reason = original ? "原会话主分支上没有这条消息（可能在已放弃的分支上）" : "本机找不到原会话文件";
    if (!await ws.ctx.ui.confirm("只能记录摘录", `${reason}。\n可以把汇编里的文字记为 excerpt_only 证据：只进时间线和评审侧，不能当截止点或输入。`)) {
        await save(ws, issue);
        return;
    }
    const session = sessions.find((item) => item === chosen.session)!;
    const raw = session.snapshot.branch.find((item) => item.id === reference.entry) as { content?: unknown } | undefined;
    const content = typeof raw?.content === "string" ? raw.content : Array.isArray(raw?.content) ? raw.content.map((block) => (block as { text?: string }).text ?? "").join("") : reference.preview;
    const excerpt = await text(ws, "摘录：只保留原文片段", content);
    if (excerpt === undefined || !content.includes(excerpt)) {
        if (excerpt !== undefined) ws.ctx.ui.notify("摘录必须是汇编消息的连续原文片段。", "error");
        return;
    }
    const role = reference.role === "assistant" || reference.role === "tool" ? reference.role : "user";
    const kind = await chooseKind(ws, role);
    if (!kind) return;
    addEvidence(issue, {
        session: key, entry: reference.sourceEntry ?? reference.entry, role, kind, at: "", excerpt,
        content_hash: digestOf(content), availability: "excerpt_only", note: `来自汇编会话 ${session.label} 的 ${reference.entry}`,
    });
    if (!issue.sessions.some((item) => item.key === key)) addSession(issue, { key, label: `会话 ${reference.sessionId.slice(0, 8)}（文件不可用）` });
    await save(ws, issue);
}

function renderTimeline(issue: Issue): string {
    const items = timeline(issue);
    if (!items.length) return "还没有证据。";
    const label = (key: string) => issue.sessions.find((session) => session.key === key)?.label ?? key;
    return items.map((item, index) => [
        `${index + 1}. ${item.at ? item.at.slice(0, 16).replace("T", " ") : "时间未知"} · ${evidenceKindLabels[item.kind]} · ${item.role}${item.availability === "excerpt_only" ? " · 仅摘录" : ""}`,
        `   ${label(item.session)} / ${item.entry}`,
        `   ${item.excerpt.replace(/\s+/g, " ").slice(0, 300)}`,
        ...(item.note ? [`   备注：${item.note}`] : []),
    ].join("\n")).join("\n\n") + (issue.resolution ? `\n\n结论（${issue.resolution.confidence === "reproduced" ? "已独立复现" : "用户报告，未独立复现"}）：${issue.resolution.statement}${issue.resolution.unknowns.length ? `\n尚不清楚：${issue.resolution.unknowns.join("；")}` : ""}` : "");
}

async function editTimeline(ws: Workspace, issue: Issue): Promise<void> {
    while (true) {
        await showText(ws.ctx.ui, `时间线：${issue.title}`, renderTimeline(issue));
        const action = await ws.ctx.ui.select("时间线", ["修改证据性质", "删除证据", "返回"]);
        if (!action || action === "返回") return;
        const item = await pick(ws.ctx.ui, action, timeline(issue), (evidence) => `${evidenceKindLabels[evidence.kind]} ${evidence.excerpt.replace(/\s+/g, " ").slice(0, 70)}`);
        if (!item) continue;
        if (action === "删除证据") issue.evidence = issue.evidence.filter((evidence) => evidence.id !== item.id);
        else {
            const kind = await chooseKind(ws, item.role, item.kind);
            if (!kind) continue;
            item.kind = kind;
        }
        await save(ws, issue);
    }
}

async function recordResolution(ws: Workspace, issue: Issue): Promise<void> {
    const statement = await text(ws, "最终结论（只进评审侧，不会出现在任何题目的输入或评分里）", issue.resolution?.statement ?? "");
    if (statement === undefined) return;
    const confidence = await ws.ctx.ui.select("结论的可靠程度", ["用户报告（如单步调试复述），未独立复现", "已独立复现"]);
    if (!confidence) return;
    const unknowns = await text(ws, "材料里没有、不能编造的细节（每行一条，可留空）", issue.resolution?.unknowns.join("\n") ?? "", false);
    if (unknowns === undefined) return;
    const source = issue.evidence.length && await ws.ctx.ui.confirm("关联出处", "要把结论关联到时间线里的一条证据吗？")
        ? await pick(ws.ctx.ui, "结论的出处", timeline(issue), (evidence) => `${evidenceKindLabels[evidence.kind]} ${evidence.excerpt.replace(/\s+/g, " ").slice(0, 70)}`)
        : undefined;
    issue.resolution = {
        statement: statement.trim(), confidence: confidence.startsWith("已独立") ? "reproduced" : "user_reported",
        unknowns: unknowns.split("\n").map((line) => line.trim()).filter(Boolean), ...(source ? { evidence: source.id } : {}),
    };
    issue.status = "resolved";
    await save(ws, issue);
}

async function reviewSlice(ws: Workspace, issue: Issue, session: LoadedSession, cutoffEntry: string, proposals = [] as Parameters<typeof applyProposals>[2]): Promise<boolean> {
    let draft;
    try {
        draft = buildSlice(ws.ctx, session, cutoffEntry, ws.version, issue);
    } catch (error) {
        ws.ctx.ui.notify(`无法整理这条回复：${error instanceof Error ? error.message : String(error)}`, "error");
        return false;
    }
    if (proposals.length) {
        const { errors } = applyProposals(draft.doc, draft.context, proposals, "model");
        if (errors.length) ws.ctx.ui.notify(`有 ${errors.length} 条提议没有加入：\n${errors.join("\n")}`, "warning");
    }
    const path = casesPath();
    return reviewCase(ws.ctx.ui, draft.doc, draft.context, path, async (confirmed) => {
        await appendCase(confirmed, path);
        // 案例已经写入；主案例更新失败只提示，不能让审阅界面重试而重复写入案例。
        recordSlice(issue, { case_id: confirmed.id, session: session.key, cutoff_entry: cutoffEntry, keys: sliceKeys(confirmed) });
        await save(ws, issue);
    }, draft.options);
}

async function sliceManually(ws: Workspace, issue: Issue): Promise<void> {
    const session = await chooseSession(ws, issue, "截止点在哪个会话？");
    if (!session) return;
    const replies = session.snapshot.messages.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.message.role === "assistant");
    const used = new Set(issue.slices.filter((slice) => slice.session === session.key).map((slice) => slice.cutoff_entry));
    const chosen = await pick(ws.ctx.ui, "选择出错的 assistant 回复作为截止点（最近的在前）", [...replies].reverse(),
        ({ entry, index }) => `#${index + 1}${used.has(entry.id) ? " [已出题]" : ""} ${entryTime(session.snapshot, entry.id).slice(0, 16)} ${messagePreview(entry.message)}`);
    if (chosen) await reviewSlice(ws, issue, session, chosen.entry.id);
}

async function sliceWithModel(ws: Workspace, issue: Issue): Promise<void> {
    const session = await chooseSession(ws, issue, "在哪个会话里找切片？");
    if (!session) return;
    const proposals = await proposeSlices(ws.ctx, issue.title, assistEntries(session, "S1"));
    if (!proposals?.length) return;
    // 同一截止点的多条提议合成一道题。
    const groups = new Map<string, typeof proposals>();
    for (const proposal of proposals) groups.set(proposal.cutoff.entry, [...(groups.get(proposal.cutoff.entry) ?? []), proposal]);
    const remaining = [...groups.entries()];
    while (remaining.length) {
        const chosen = await pick(ws.ctx.ui, `模型提议 ${remaining.length} 道题（已核对编号、引文和违反片段）`, remaining,
            ([, items]) => `${items[0].cutoff.ref} ${items.map((item) => item.norm ?? item.basis).join("+")} ${items[0].requirement}`);
        if (!chosen) return;
        const [cutoffEntry, items] = chosen;
        await showText(ws.ctx.ui, "提议详情", items.map((item) => [
            `截止点 ${item.cutoff.ref}：${messagePreview(item.cutoff.message, 200)}`,
            `依据：${item.basis}${item.norm ? ` ${item.norm}` : ""}；出处 ${item.source.ref}「${item.quote}」`,
            `违反片段：${item.violation}`, `要求：${item.requirement}`, `理由：${item.reason}`,
        ].join("\n")).join("\n\n"));
        const action = await ws.ctx.ui.select("怎么处理这道题？", ["审阅并保存", "拒绝", "返回列表"]);
        if (action === "审阅并保存") {
            if (await reviewSlice(ws, issue, session, cutoffEntry, items)) remaining.splice(remaining.indexOf(chosen), 1);
        } else if (action === "拒绝") remaining.splice(remaining.indexOf(chosen), 1);
    }
}

async function mergeOrSplit(ws: Workspace, issue: Issue, issues: Issue[]): Promise<void> {
    const action = await ws.ctx.ui.select("合并或拆分", ["把另一个主案例合并进来", "把部分证据拆成新主案例", "返回"]);
    if (action === "把另一个主案例合并进来") {
        const other = await pick(ws.ctx.ui, "合并哪个主案例？（它会被标记为已删除）", issues.filter((item) => item.id !== issue.id), (item) => item.title);
        if (!other || !await ws.ctx.ui.confirm("确认合并", `把「${other.title}」的会话、证据和切片合并到「${issue.title}」。已导出的切片 group_key 不会自动改变。`)) return;
        mergeIssues(issue, other);
        other.deleted = true;
        if (await save(ws, issue)) await save(ws, other);
    } else if (action === "把部分证据拆成新主案例") {
        const ids: string[] = [];
        while (true) {
            const rest = timeline(issue).filter((item) => !ids.includes(item.id));
            const item = await pick(ws.ctx.ui, `选择要拆出的证据（已选 ${ids.length} 条，按返回结束）`, rest, (evidence) => `${evidenceKindLabels[evidence.kind]} ${evidence.excerpt.replace(/\s+/g, " ").slice(0, 70)}`);
            if (!item) break;
            ids.push(item.id);
        }
        if (!ids.length) return;
        const title = await text(ws, "新主案例的标题");
        if (title === undefined) return;
        const created = splitIssue(issue, ids, title.trim());
        if (await save(ws, created)) await save(ws, issue);
        ws.ctx.ui.notify(`已拆出「${created.title}」，包含 ${ids.length} 条证据。`, "info");
    }
}

async function issueMenu(ws: Workspace, issue: Issue, issues: Issue[]): Promise<void> {
    while (true) {
        const actions = [
            `会话（${issue.sessions.length} 个）：添加其他会话`,
            "从汇编消息回到原会话",
            `时间线（${issue.evidence.length} 条证据）`,
            "添加证据（人工）",
            "用模型找证据",
            "新建切片（人工选截止点）",
            "用模型提议切片",
            `${issue.resolution ? "修改" : "记录"}最终结论`,
            "合并或拆分",
            "删除主案例",
            "返回",
        ];
        const action = await ws.ctx.ui.select(`${issue.title}\n${issue.evidence.length} 条证据，${issue.slices.length} 道已确认的题${issue.resolution ? "，已记录结论" : ""}`, actions);
        if (!action || action === "返回") return;
        try {
            if (action === actions[0]) await addOtherSession(ws, issue);
            else if (action === actions[1]) await traceAssembled(ws, issue);
            else if (action === actions[2]) await editTimeline(ws, issue);
            else if (action === actions[3]) await addEvidenceManually(ws, issue);
            else if (action === actions[4]) await addEvidenceWithModel(ws, issue);
            else if (action === actions[5]) await sliceManually(ws, issue);
            else if (action === actions[6]) await sliceWithModel(ws, issue);
            else if (action === actions[7]) await recordResolution(ws, issue);
            else if (action === actions[8]) { await mergeOrSplit(ws, issue, issues); if (issue.deleted) return; }
            else if (action === actions[9]) {
                if (!await ws.ctx.ui.confirm("删除主案例", `只删除「${issue.title}」的本地整理记录；已保存的切片案例不受影响。`)) continue;
                issue.deleted = true;
                await save(ws, issue);
                return;
            }
        } catch (error) {
            ws.ctx.ui.notify(`操作未完成：${error instanceof Error ? error.message : String(error)}`, "error");
        }
    }
}

export async function manageIssues(pi: ExtensionAPI, ctx: ExtensionCommandContext, version: string, snapshot: SessionSnapshot): Promise<void> {
    const current = currentSession(ctx, snapshot);
    const ws: Workspace = { pi, ctx, version, current, loaded: new Map([[current.key, current]]) };
    while (true) {
        const issues = await loadIssues();
        const choice = await pick(ctx.ui, "长程问题：选择主案例", [{ create: true } as const, ...issues.map((issue) => ({ issue }))],
            (item) => "issue" in item ? `${item.issue.title}（${item.issue.evidence.length} 条证据，${item.issue.slices.length} 道题${item.issue.status === "resolved" ? "，已有结论" : ""}）` : "新建主案例");
        if (!choice) return;
        let issue = "issue" in choice ? choice.issue : undefined;
        if (!issue) {
            const title = await text(ws, "主案例标题：一句话说明要解决的问题");
            if (title === undefined) continue;
            issue = newIssue(title.trim());
            addSession(issue, { key: current.key, ...(current.file ? { file: current.file } : {}), label: current.label });
            if (!await save(ws, issue)) continue;
        } else if (!issue.sessions.some((session) => session.key === current.key)
            && await ctx.ui.confirm("加入当前会话？", `当前会话还不在「${issue.title}」里，要加进去吗？`)) {
            addSession(issue, { key: current.key, ...(current.file ? { file: current.file } : {}), label: current.label });
            await save(ws, issue);
        }
        await issueMenu(ws, issue, issues);
    }
}
