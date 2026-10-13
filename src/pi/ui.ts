import { stripVTControlCharacters } from "node:util";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Check as CheckSchema, schemaErrors, type CaseDocument, type Check, type Requirement, type RequirementBasis, type Rubric } from "../schema/case.ts";
import { messagePreview } from "../core/candidates.ts";
import { basisOf, refreshDraft, setBasis } from "../core/draft-rule.ts";
import { lintCase, type LintResult } from "../core/lint.ts";
import { contextSource, type CaseContext } from "../core/messages.ts";
import { emptyRubric, observedTexts, rubricForCheck, rubricHints } from "../core/rubric.ts";
import { findNorm, norms, normsVersion, rubricForNorm } from "../core/norms.ts";

const display = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

export async function pick<T>(ui: ExtensionUIContext, title: string, values: readonly T[], label: (value: T, index: number) => string): Promise<T | undefined> {
    if (!values.length) return undefined;
    let page = 0;
    while (true) {
        const start = page * 8;
        const rows = values.slice(start, start + 8).map((value, index) => `${start + index + 1}. ${display(label(value, start + index))}`);
        const options = [...rows, ...(start + 8 < values.length ? ["下一页"] : []), ...(page ? ["上一页"] : []), "返回"];
        const selected = await ui.select(`${title}（第 ${page + 1} / ${Math.ceil(values.length / 8)} 页）`, options);
        if (!selected || selected === "返回") return undefined;
        if (selected === "下一页") page++;
        else if (selected === "上一页") page--;
        else return values[start + rows.indexOf(selected)];
    }
}

// 用原生只读选择框分页，不把可编辑文本框伪装成预览。
export async function showText(ui: ExtensionUIContext, title: string, text: string): Promise<void> {
    const lines = display(text).split("\n").flatMap((line) => {
        const characters = Array.from(line);
        return characters.length ? Array.from({ length: Math.ceil(characters.length / 70) }, (_, index) => characters.slice(index * 70, (index + 1) * 70).join("")) : [""];
    });
    let page = 0;
    const count = Math.max(1, Math.ceil(lines.length / 8));
    while (true) {
        const choice = await ui.select(`${title}（${page + 1}/${count}）\n\n${lines.slice(page * 8, (page + 1) * 8).join("\n")}`,
            [...(page + 1 < count ? ["下一页"] : []), ...(page ? ["上一页"] : []), "返回"]);
        if (choice === "下一页") page++;
        else if (choice === "上一页") page--;
        else return;
    }
}

type PromptEditor = (title: string, prefill?: string, dialogOptions?: object, editorOptions?: { promptStyle?: boolean }) => Promise<string | undefined>;

// OMP 的编辑框默认 Ctrl+Q / Ctrl+Enter 提交；promptStyle 改为回车提交、Shift+Enter 换行，和主输入框一致。
// Pi 的编辑框本来就是回车提交，只接收前两个参数，多余的参数被忽略。
export function promptEditor(ui: ExtensionUIContext, title: string, prefill = ""): Promise<string | undefined> {
    return (ui.editor as PromptEditor).call(ui, title, prefill, undefined, { promptStyle: true });
}

async function editText(ui: ExtensionUIContext, title: string, prefill = "", required = true): Promise<string | undefined> {
    while (true) {
        const text = await promptEditor(ui, title, prefill);
        if (text === undefined) return undefined;
        if (!required || text.trim()) return text;
        ui.notify("请填写内容，或按取消返回。", "warning");
    }
}

async function editCheck(ui: ExtensionUIContext, current: Check[]): Promise<Check[] | undefined> {
    const choices = ["不使用程序约束", "只输出合法 JSON", "必须包含文字", "不能包含文字", "必须匹配正则", "不能匹配正则", "必须调用工具", "不能调用工具"];
    const choice = await ui.select("程序约束（可选；复杂要求可以只使用评审标准）", [...(current.length ? ["保留现有约束"] : []), ...choices]);
    if (!choice) return undefined;
    if (choice === "保留现有约束") return structuredClone(current);
    if (choice === choices[0]) return [];
    if (choice === choices[1]) return [{ type: "json_only" }];
    let check: Check;
    if (choice === choices[2] || choice === choices[3]) {
        const text = await editText(ui, "要匹配的原样文字");
        if (text === undefined) return undefined;
        const sensitivity = await ui.select("大小写处理", ["区分大小写", "忽略大小写"]);
        if (!sensitivity) return undefined;
        check = { type: choice === choices[2] ? "contains" : "not_contains", text, ignore_case: sensitivity === "忽略大小写" };
    } else if (choice === choices[4] || choice === choices[5]) {
        const pattern = await editText(ui, "正则表达式（ECMAScript）");
        if (pattern === undefined) return undefined;
        const flags = await editText(ui, "正则 flags（可留空，只支持 i、m、s、u）", "", false);
        if (flags === undefined) return undefined;
        try { new RegExp(pattern, flags); } catch {
            ui.notify("正则表达式或 flags 无效，未修改约束。", "error");
            return undefined;
        }
        check = { type: choice === choices[4] ? "regex" : "not_regex", pattern, flags };
    } else {
        const name = await editText(ui, "工具名称（与录制调用的名字一致）");
        if (name === undefined) return undefined;
        const args = await editText(ui, "参数条件（JSON 对象；留空表示不限制参数）", "", false);
        if (args === undefined) return undefined;
        let argsMatch: Record<string, unknown> | undefined;
        if (args.trim()) {
            try {
                const parsed: unknown = JSON.parse(args);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
                argsMatch = parsed as Record<string, unknown>;
            } catch {
                ui.notify("参数条件必须是 JSON 对象，未修改约束。", "error");
                return undefined;
            }
        }
        check = { type: choice === choices[6] ? "tool_called" : "tool_not_called", name, ...(argsMatch === undefined ? {} : { args_match: argsMatch }) };
    }
    const errors = schemaErrors(CheckSchema, check);
    if (errors.length) {
        ui.notify(errors.map((error) => error.message).join("\n"), "error");
        return undefined;
    }
    return [check];
}

async function editRubric(ui: ExtensionUIContext, initial: Rubric, context: CaseContext, quote: string): Promise<Rubric | undefined> {
    const rubric = structuredClone(initial);
    for (const field of ["question", "pass", "fail"] as const) {
        const label = { question: "判定问题", pass: "通过条件", fail: "违反条件" }[field];
        const value = await editText(ui, `${label}：${rubricHints[field]}\n原要求：${display(quote)}\n原输出：${display(messagePreview(context.observed, 160))}`, rubric[field]);
        if (value === undefined) return undefined;
        rubric[field] = value;
    }
    const edgeCases = await editText(ui, "边界情况（每行一条，可留空）", (rubric.edge_cases ?? []).join("\n"), false);
    if (edgeCases === undefined) return undefined;
    rubric.edge_cases = edgeCases.split("\n").map((line) => line.trim()).filter(Boolean);
    const scope = await ui.select("评审看哪部分回复？", rubric.scope === "tool_calls" ? ["工具调用", "文字"] : ["文字", "工具调用"]);
    if (!scope) return undefined;
    rubric.scope = scope === "文字" ? "final_text" : "tool_calls";

    const excerpts = observedTexts(context.observed).filter((text) => text.trim());
    if (!excerpts.length) {
        ui.notify("这条回复没有可摘录的文字或工具参数，无法提供必需的原文反例，请选择其他回复。", "error");
        return undefined;
    }
    const original = await pick(ui, "从原出错输出选择反例出处", excerpts, (text) => text.replace(/\s+/g, " ").slice(0, 90));
    if (original === undefined) return undefined;
    const existing = rubric.examples.find((example) => example.origin === "observed" && example.verdict === "fail" && original.includes(example.text));
    while (true) {
        const excerpt = await editText(ui, "违反例子：只保留原文片段，不要改写", existing?.text ?? original);
        if (excerpt === undefined) return undefined;
        if (!original.includes(excerpt)) {
            ui.notify("例子必须是刚才所选原输出的连续原文片段。", "error");
            continue;
        }
        rubric.examples = [
            ...rubric.examples.filter((example) => !(example.origin === "observed" && example.verdict === "fail")),
            { verdict: "fail", origin: "observed", text: excerpt },
        ];
        return rubric;
    }
}

const basisLabels = {
    instruction: "用户或系统明确提的要求（instruction）",
    evidence: "截止点之前和这条回复矛盾的事实（evidence）",
    norm: "工作规范表里的一条规范（norm）",
} as const;

async function chooseBasis(ui: ExtensionUIContext, previous?: RequirementBasis): Promise<RequirementBasis | undefined> {
    const order = (["instruction", "evidence", "norm"] as const).slice().sort((a, b) => (a === previous?.basis ? -1 : b === previous?.basis ? 1 : 0));
    const labels: string[] = order.map((key) => basisLabels[key]);
    const choice = await ui.select("这条要求的依据是什么？（出处都必须在截止点之前）", labels);
    if (!choice) return undefined;
    const basis = order[labels.indexOf(choice)];
    if (basis !== "norm") return { basis };
    const norm = await pick(ui, `选择规范（casepick.norms/${normsVersion}）`, norms, (item) => `${item.id} ${item.title}；生效条件：${item.trigger}`);
    return norm ? { basis: "norm", norm: norm.id, norms_version: normsVersion } : undefined;
}

async function editRequirement(ui: ExtensionUIContext, context: CaseContext, id: string, previous?: Requirement, previousBasis?: RequirementBasis):
    Promise<{ requirement: Requirement; basis: RequirementBasis } | undefined> {
    const basis = await chooseBasis(ui, previousBasis);
    if (!basis) return undefined;
    // instruction 引用用户原话；evidence / norm 引用用户陈述或工具输出，不能引用助手自己的回复。
    const roles = basis.basis === "instruction" ? ["user"] : ["user", "tool"];
    const sources = context.input.map((entry, index) => ({ ...entry, index })).filter((entry) => roles.includes(entry.message.role));
    if (!sources.length) {
        ui.notify("截止点之前没有可引用的消息，无法建立要求出处。", "warning");
        return undefined;
    }
    const prompt = basis.basis === "instruction" ? "选择截止点之前提出要求的消息"
        : basis.basis === "evidence" ? "选择截止点之前和这条回复矛盾的事实（用户陈述或工具输出）"
        : `选择让规范 ${basis.norm} 生效的证据（用户陈述或工具输出）`;
    // 最近的消息优先展示，保存的引用仍使用 task.messages 的真实下标。
    const source = await pick(ui, prompt, sources.reverse(), (entry) => `消息 #${entry.index + 1} ${entry.message.role}：${messagePreview(entry.message)}`);
    if (!source) return undefined;
    const original = source.message.content ?? "";
    let quote: string;
    while (true) {
        const entered = await editText(ui, "要求出处：只保留要引用的原文片段", previous?.source.message === source.index ? previous.source.quote : original);
        if (entered === undefined) return undefined;
        if (!original.includes(entered)) { ui.notify("引文必须在所选消息中原样出现。", "error"); continue; }
        quote = entered;
        break;
    }
    const norm = basis.basis === "norm" ? findNorm(basis.norm) : undefined;
    const text = await editText(ui, "这一条要求是什么？", previous?.text ?? (norm ? norm.title : quote));
    if (text === undefined) return undefined;
    const checks = await editCheck(ui, previous?.checks ?? []);
    if (!checks) return undefined;
    const sameBasis = previousBasis?.basis === basis.basis && (basis.basis !== "norm" || (previousBasis.basis === "norm" && previousBasis.norm === basis.norm));
    const sameChecks = previous && sameBasis && JSON.stringify(checks) === JSON.stringify(previous.checks ?? []);
    const initial = sameChecks ? previous.rubric : checks.length === 1 ? rubricForCheck(checks[0], context.observed) : norm ? rubricForNorm(norm) : emptyRubric();
    const rubric = await editRubric(ui, initial, context, quote);
    if (!rubric) return undefined;
    return { requirement: { id, text, required: true, source: { message: source.index, quote }, ...(checks.length ? { checks } : {}), rubric }, basis };
}

function basisText(basis: RequirementBasis): string {
    if (basis.basis === "norm") return `规范 ${basis.norm} ${findNorm(basis.norm)?.title ?? ""}`;
    return basis.basis === "evidence" ? "截止点之前的事实" : "用户原话";
}

function renderReview(doc: CaseDocument, result: LintResult): string {
    return [
        doc.title,
        `输入 ${doc.task.messages.length} 条消息；只评审出错位置的下一条回复。`,
        `评审方式：${result.reviewMode === "program" ? "有有效程序约束" : "按评审标准判断"}`,
        ...doc.scoring.requirements.flatMap((requirement) => [
            "", `要求 ${requirement.id}：${requirement.text}`, `依据：${basisText(basisOf(doc, requirement.id))}`, `出处：消息 #${requirement.source.message + 1}「${requirement.source.quote}」`,
            `判定问题：${requirement.rubric.question}`, `通过：${requirement.rubric.pass}`, `违反：${requirement.rubric.fail}`,
            ...(requirement.rubric.edge_cases ?? []).map((text) => `边界：${text}`),
            ...requirement.rubric.examples.map((example) => `例子（${example.verdict === "fail" ? "违反" : "通过"}，${example.origin === "observed" ? "原输出" : "编写"}）：${example.text}`),
            ...(requirement.checks ?? []).map((check) => `程序约束：${JSON.stringify(check)}`),
        ]),
        "", "原出错输出：", doc.diagnostic.observed.content ?? "（无文字）",
        ...(doc.diagnostic.observed.tool_calls ?? []).map((call) => `工具 ${call.function.name}：${call.function.arguments}`),
        "", "局限：", ...[...(doc.task.limitations ?? []), ...(doc.provenance.limitations ?? [])].map((item) => item.note ?? item.field),
        "", "检查结果：", ...(result.issues.length ? result.issues.map((issue) => `${issue.severity === "error" ? "错误" : "提示"} ${issue.path}：${issue.message}`) : ["通过"]),
    ].join("\n");
}

export interface ReviewOptions {
    // 截止点之后才出现的其他内容，参与防后见之明检查。
    laterTexts?: readonly string[];
    // 给 evidence / norm 依据找出处对应的主案例证据 ID。
    linkEvidence?: (quote: string) => string[];
    // 和同一主案例已确认的切片重复时返回说明。
    duplicates?: (doc: CaseDocument) => string | undefined;
    // 用模型为这个截止点起草要求；返回新增的要求条数。
    modelDraft?: (doc: CaseDocument) => Promise<number>;
}

export async function reviewCase(ui: ExtensionUIContext, doc: CaseDocument, context: CaseContext, path: string,
    save: (confirmed: CaseDocument) => Promise<void>, options: ReviewOptions = {}): Promise<boolean> {
    let preview = true;
    const link = () => {
        if (!options.linkEvidence) return;
        for (const requirement of doc.scoring.requirements) {
            const basis = basisOf(doc, requirement.id);
            if (basis.basis === "instruction") continue;
            const refuted = options.linkEvidence(requirement.source.quote);
            const updated = { ...basis } as RequirementBasis & { refuted_by?: string[] };
            if (refuted.length) updated.refuted_by = refuted;
            else delete updated.refuted_by;
            setBasis(doc, requirement.id, updated);
        }
    };
    while (true) {
        link();
        refreshDraft(doc);
        const result = lintCase(doc, { stage: "confirm", source: contextSource(context), laterTexts: options.laterTexts });
        if (preview) { await showText(ui, "审阅案例", renderReview(doc, result)); preview = false; }
        const actions = ["确认保存", "编辑标题", "添加要求", "编辑要求与评审标准", "删除要求", "设置环境依赖", "查看案例与检查结果", "查看完整输入", "返回候选（暂不保存）",
            ...(options.modelDraft ? ["用模型起草要求"] : [])];
        const action = await ui.select(`${display(doc.title)}\n${doc.scoring.requirements.length} 条要求；${result.issues.filter((issue) => issue.severity === "error").length} 个错误，${result.issues.filter((issue) => issue.severity === "warning").length} 个提示`, actions);
        if (!action || action === actions[8]) return false;
        if (action === actions[0]) {
            if (!result.valid || !result.cutoffVerified) {
                await showText(ui, "请先处理错误，再确认保存", renderReview(doc, result));
                continue;
            }
            if (doc.title === "待填写案例标题" || !doc.title.trim()) {
                ui.notify("请先填写能说明问题的案例标题。", "warning");
                continue;
            }
            const duplicate = options.duplicates?.(doc);
            if (duplicate && !await ui.confirm("疑似重复的切片", `${duplicate}\n同一个错误重复出现时，通常只为最早的一次出题。仍然保存？`)) continue;
            const warnings = result.issues.filter((issue) => issue.severity === "warning");
            if (warnings.length) await showText(ui, "保存前请核对这些提示", warnings.map((issue) => `${issue.path}：${issue.message}`).join("\n\n"));
            if (!await ui.confirm("确认保存案例", `${display(doc.title)}\n将保存完整输入、原出错输出和评审标准到本机：\n${path}\n约 ${Math.ceil(Buffer.byteLength(JSON.stringify(doc)) / 1024)} KB${warnings.length ? `；确认接受上面的 ${warnings.length} 项提示` : ""}。`)) continue;
            const confirmed = structuredClone(doc);
            confirmed.extensions!["x-casepick"]!.confirmed_at = new Date().toISOString();
            try {
                await save(confirmed);
                ui.notify(`已保存 ${confirmed.id}\n${path}`, "info");
                return true;
            } catch (error) {
                ui.notify(`保存失败，草稿仍在，可以重试：${error instanceof Error ? error.message : String(error)}`, "error");
            }
        } else if (action === actions[1]) {
            const title = await editText(ui, "案例标题", doc.title === "待填写案例标题" ? "" : doc.title);
            if (title !== undefined) doc.title = title;
        } else if (action === actions[2] || action === actions[3]) {
            const previous = action === actions[3] ? await pick(ui, "编辑哪条要求？", doc.scoring.requirements, (requirement) => requirement.text) : undefined;
            if (action === actions[3] && !previous) continue;
            let id = previous?.id ?? `r${doc.scoring.requirements.length + 1}`;
            while (!previous && doc.scoring.requirements.some((requirement) => requirement.id === id)) id += "_new";
            const edited = await editRequirement(ui, context, id, previous, previous ? basisOf(doc, previous.id) : undefined);
            if (edited) {
                const { requirement, basis } = edited;
                if (previous) doc.scoring.requirements[doc.scoring.requirements.indexOf(previous)] = requirement;
                else doc.scoring.requirements.push(requirement);
                setBasis(doc, requirement.id, basis);
                doc.extensions!["x-casepick"]!.rubric_edited = true;
                doc.provenance.producer.method = "manual";
                if (doc.scoring.producer) doc.scoring.producer.method = "manual";
                preview = true;
            }
        } else if (action === actions[4]) {
            const requirement = await pick(ui, "删除哪条要求？", doc.scoring.requirements, (item) => item.text);
            if (requirement) {
                doc.scoring.requirements.splice(doc.scoring.requirements.indexOf(requirement), 1);
                setBasis(doc, requirement.id, undefined);
            }
        } else if (action === actions[5]) {
            const kind = await ui.select("这条要求是否依赖当时的文件、数据库或外部状态？", ["不依赖", "依赖，但当时环境无法恢复"]);
            if (!kind) continue;
            if (kind === "不依赖") {
                doc.task.environment.kind = "none";
                doc.task.limitations = (doc.task.limitations ?? []).filter((item) => item.field !== "task.environment");
            } else {
                const note = await editText(ui, "说明缺少的环境，以及只能从回复中判断的部分", doc.task.limitations?.find((item) => item.field === "task.environment")?.note);
                if (note === undefined) continue;
                doc.task.environment.kind = "unavailable";
                doc.task.limitations = [...(doc.task.limitations ?? []).filter((item) => item.field !== "task.environment"), { field: "task.environment", status: "unrecoverable", note }];
            }
        } else if (action === "用模型起草要求" && options.modelDraft) {
            try {
                if (await options.modelDraft(doc)) preview = true;
            } catch (error) {
                ui.notify(`模型起草未完成：${error instanceof Error ? error.message : String(error)}`, "error");
            }
        } else if (action === actions[6]) preview = true;
        else if (action === actions[7]) await showText(ui, "截止点之前的完整输入", [
            `系统提示（${doc.task.system.status}）：\n${doc.task.system.content ?? "未记录"}`,
            ...doc.task.messages.map((message, index) => `#${index + 1} ${message.role}\n${message.content ?? ""}${message.role === "assistant" && message.tool_calls ? `\n${JSON.stringify(message.tool_calls, null, 2)}` : ""}`),
            `工具定义：\n${JSON.stringify(doc.task.tools, null, 2)}`,
        ].join("\n\n"));
    }
}
