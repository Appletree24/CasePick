import {
    Rubric as RubricSchema,
    schemaErrors,
    type AssistantMessage,
    type Check,
    type Rubric,
    type SchemaError,
} from "../schema/case.ts";
import { evaluateCheck } from "./checks.ts";

// 提示单独给编辑界面使用，不把占位文字当成已填写的评审标准。
export const rubricHints = {
    question: "写一个是 / 否问题，是表示符合这一条原要求。",
    pass: "描述输出中可以直接观察到的通过条件。",
    fail: "描述违反条件，与通过条件一起覆盖所有情况。",
    edge_cases: "写明容易误判的情况，以及每种情况的判法。",
    examples: "至少摘录一段原出错输出，作为 origin: observed 的 fail 例子；工具调用摘录参数 JSON 原文。",
} as const;

// 返回可编辑草稿；空字段和空例子必须由用户补齐，不能直接确认。
export function emptyRubric(): Rubric {
    return { question: "", pass: "", fail: "", edge_cases: [], examples: [], scope: "final_text" };
}

// 出处核对只使用文字和每次工具调用的参数原文，不重新序列化整个消息，避免引入并不存在的引文。
export function observedTexts(observed: AssistantMessage): string[] {
    return [observed.content ?? "", ...(observed.tool_calls ?? []).map((call) => call.function.arguments)];
}

// 只在程序确定抓到了原来的错误时预填反例；空输出或 unknown 留给人工补充。
function observedExamples(check: Check, observed?: AssistantMessage): Rubric["examples"] {
    if (!observed || evaluateCheck(check, observed).verdict !== "fail") return [];
    let texts: string[];
    if (check.type === "tool_not_called") {
        texts = (observed.tool_calls ?? [])
            .filter((call) => evaluateCheck(check, { role: "assistant", content: null, tool_calls: [call] }).verdict === "fail")
            .map((call) => call.function.arguments);
    } else if (check.type === "tool_called") {
        // 缺失调用只能用整条录制回复作示例，不能杜撰一段不存在的调用。
        texts = observedTexts(observed);
    } else {
        texts = [observed.content ?? ""];
    }
    return [...new Set(texts)].filter((text) => text.trim().length > 0)
        .map((text) => ({ verdict: "fail", origin: "observed", text }));
}

// 七种离线约束的默认模板。语义与 evaluateCheck 一致，不执行工具、不调用评审模型。
export function rubricForCheck(check: Check, observed?: AssistantMessage): Rubric {
    const rubric = emptyRubric();
    rubric.scope = "name" in check ? "tool_calls" : check.scope ?? "final_text";
    switch (check.type) {
        case "json_only":
            rubric.question = "回答是否整体只是一个合法 JSON 值，JSON 之外没有任何文字？";
            rubric.pass = "忽略首尾 JSON 空白后，整个回答能被解析为一个 JSON 值。";
            rubric.fail = "回答为空、JSON 语法无效、有多个 JSON 值，或 JSON 前后出现说明、标题、Markdown 代码块标记等非 JSON 内容。";
            rubric.edge_cases = [
                "首尾的空格、制表符、回车和换行不算违反。",
                "对象、数组、字符串、数字、布尔值和 null 都是合法 JSON 值。",
                "JSON 字符串值内部的文字不算额外解释。",
            ];
            break;
        case "contains":
        case "not_contains": {
            const target = JSON.stringify(check.text);
            const matching = check.ignore_case ? "两边按 ECMAScript toLowerCase() 转成小写后比较" : "区分大小写";
            const present = `指定范围包含连续文字 ${target}（${matching}）。`;
            const absent = `指定范围不包含连续文字 ${target}（${matching}）。`;
            rubric.question = `指定范围是否${check.type === "contains" ? "包含" : "不包含"}连续文字 ${target}？`;
            rubric.pass = check.type === "contains" ? present : absent;
            rubric.fail = check.type === "contains" ? absent : present;
            rubric.edge_cases = ["只做连续子串匹配，不按语义、同义词或整词匹配；空格和标点参与比较。"];
            break;
        }
        case "regex":
        case "not_regex": {
            const expression = `ECMAScript 正则 ${JSON.stringify(check.pattern)}（flags: ${JSON.stringify(check.flags ?? "")}）`;
            const present = `指定范围至少有一处匹配${expression}。`;
            const absent = `指定范围没有任何一处匹配${expression}。`;
            rubric.question = `指定范围是否${check.type === "regex" ? "匹配" : "不匹配"}${expression}？`;
            rubric.pass = check.type === "regex" ? present : absent;
            rubric.fail = check.type === "regex" ? absent : present;
            rubric.edge_cases = [
                "使用正则 test 的匹配语义；只有表达式本身要求时才做整段匹配。",
                "大小写、换行和 Unicode 的处理由 flags 决定。",
            ];
            break;
        }
        case "tool_called":
        case "tool_not_called": {
            const target = `名为 ${JSON.stringify(check.name)} 的工具调用`;
            const args = check.args_match === undefined ? "" : `（参数匹配对象子集 ${JSON.stringify(check.args_match)}）`;
            const present = `本条回复存在${target}${args}。`;
            const absent = `本条回复不存在${target}${args}。`;
            rubric.question = `本条回复是否${check.type === "tool_called" ? "存在" : "不存在"}${target}${args}？`;
            rubric.pass = check.type === "tool_called" ? present : absent;
            rubric.fail = check.type === "tool_called" ? absent : present;
            rubric.edge_cases = [
                "只检查本条回复中记录的 tool_calls；在文字中提到工具名不算调用，不判断工具是否执行成功。",
                ...(check.args_match === undefined ? ["未限定参数时，只按工具名精确匹配。"] : [
                    "参数解析为 JSON 对象后递归匹配自有属性子集；额外属性不影响匹配，数组按完整值、长度和顺序匹配。",
                    "任意一次确定匹配即可认定存在；同名调用的参数无效且没有其他确定匹配时无法判定，需要人工补充证据。",
                ]),
            ];
            break;
        }
    }
    if (!("name" in check)) {
        rubric.edge_cases!.push(check.scope === "tool_calls"
            ? "工具调用的文字序列化规则尚未定义，此模板需要人工明确判定范围后才能使用。"
            : "只看本条回复的 content；null 按空文字处理，不包含工具参数。final_text 和 all_text 在此处相同。");
    }
    rubric.examples = observedExamples(check, observed);
    return rubric;
}

// 和 schemaErrors 一样返回字段路径；仅检查结构和空白，不评判 rubric 的语义好坏。
export function rubricErrors(value: unknown): SchemaError[] {
    const errors = schemaErrors(RubricSchema, value);
    if (errors.length > 0) return errors;
    const rubric = value as Rubric;
    const fields: [string, string][] = [
        ["/question", rubric.question], ["/pass", rubric.pass], ["/fail", rubric.fail],
        ...(rubric.edge_cases ?? []).map((text, index): [string, string] => [`/edge_cases/${index}`, text]),
        ...rubric.examples.map(({ text }, index): [string, string] => [`/examples/${index}/text`, text]),
    ];
    return fields.filter(([, text]) => text.trim().length === 0)
        .map(([path]) => ({ path, message: "必须填写非空白文字" }));
}
