// CasePick 产出的 Detroit 评测集格式 v2（Detroit docs/10-dataset-format.md）。
// 这里只描述 CasePick 实际会产出的子集，并且比协议更严格：
// 凡是这里接受的文档，Detroit 的 JSON Schema 也必须接受，测试会核对这一点。
// 摘要一致、引文出处等跨字段检查不在这里，见 core/lint.ts。

// 固定使用本地 TypeBox 子路径，与 Value 配套；OMP 会将裸包入口替换为 omptype。
import { type Static, type TSchema, Type } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";

const closed = { additionalProperties: false } as const;

function Strict<T extends Record<string, TSchema>>(properties: T) {
    return Type.Object(properties, closed);
}

const NonEmpty = Type.String({ minLength: 1 });

export const Digest = Type.String({ pattern: "^sha256:[0-9a-f]{64}$" });
export const CaseId = Type.String({ pattern: "^casepick:[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 256 });
const Revision = Type.Integer({ minimum: 1 });
// RFC 3339，必须带时区。用正则而不是 format，免得依赖格式注册表。
const Timestamp = Type.String({
    pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$",
});

// ---------- 消息：OpenAI Chat Completions 格式，不含 system ----------

export const ToolCall = Strict({
    id: NonEmpty,
    type: Type.Literal("function"),
    function: Strict({ name: NonEmpty, arguments: Type.String() }),
});

const UserMessage = Strict({
    role: Type.Literal("user"),
    content: Type.String(),
    name: Type.Optional(Type.String()),
});

// assistant 消息要么有文字，要么有工具调用（也可以都有）。
const AssistantText = Strict({
    role: Type.Literal("assistant"),
    content: Type.String(),
    tool_calls: Type.Optional(Type.Array(ToolCall, { minItems: 1 })),
    name: Type.Optional(Type.String()),
});
const AssistantToolCalls = Strict({
    role: Type.Literal("assistant"),
    content: Type.Union([Type.String(), Type.Null()]),
    tool_calls: Type.Array(ToolCall, { minItems: 1 }),
    name: Type.Optional(Type.String()),
});
export const AssistantMessage = Type.Union([AssistantText, AssistantToolCalls]);

const ToolMessage = Strict({
    role: Type.Literal("tool"),
    tool_call_id: NonEmpty,
    content: Type.String(),
});

export const Message = Type.Union([UserMessage, AssistantMessage, ToolMessage]);

export const ToolDefinition = Strict({
    type: Type.Literal("function"),
    function: Strict({
        name: NonEmpty,
        description: Type.Optional(Type.String()),
        parameters: Type.Optional(Type.Object({})),
        strict: Type.Optional(Type.Boolean()),
    }),
});

// ---------- 局限与改动 ----------

export const Limitation = Strict({
    field: NonEmpty,
    status: Type.Union([Type.Literal("missing"), Type.Literal("approximate"), Type.Literal("unrecoverable")]),
    note: Type.Optional(Type.String()),
});

export const Transform = Strict({
    type: Type.Union([
        Type.Literal("redact"),
        Type.Literal("truncate"),
        Type.Literal("omit_image"),
        Type.Literal("drop_thinking"),
    ]),
    target: NonEmpty,
    detail: Type.Optional(Type.String()),
});

// ---------- task：截止点之前，被测模型能看到的全部内容 ----------

export const Task = Strict({
    kind: Type.Literal("agent"),
    // CasePick 只判出错位置的下一条回复，不执行工具。
    horizon: Type.Literal("next_message"),
    start: Type.Literal("current"),
    instruction: Type.Optional(Type.String()),
    messages: Type.Array(Message, { minItems: 1 }),
    system: Strict({
        status: Type.Union([Type.Literal("captured"), Type.Literal("approximate"), Type.Literal("missing")]),
        content: Type.Union([Type.String(), Type.Null()]),
    }),
    tools: Strict({
        source: Type.Union([Type.Literal("captured"), Type.Literal("approximate"), Type.Literal("none")]),
        definitions: Type.Optional(Type.Array(ToolDefinition)),
    }),
    environment: Strict({
        kind: Type.Union([Type.Literal("none"), Type.Literal("unavailable")]),
    }),
    output: Strict({
        format: Type.Union([Type.Literal("text"), Type.Literal("json"), Type.Literal("tool_calls")]),
        description: Type.Optional(Type.String()),
    }),
    limitations: Type.Optional(Type.Array(Limitation)),
});

// ---------- 评分 ----------

const Scope = Type.Union([Type.Literal("final_text"), Type.Literal("all_text"), Type.Literal("tool_calls")]);

// 只产出协议登记表里的离线检查（技术设计第 7 节"约束类型"）。
export const Check = Type.Union([
    Strict({ type: Type.Literal("json_only"), scope: Type.Optional(Scope) }),
    Strict({
        type: Type.Union([Type.Literal("contains"), Type.Literal("not_contains")]),
        text: NonEmpty,
        ignore_case: Type.Optional(Type.Boolean()),
        scope: Type.Optional(Scope),
    }),
    Strict({
        type: Type.Union([Type.Literal("regex"), Type.Literal("not_regex")]),
        pattern: NonEmpty,
        flags: Type.Optional(Type.String({ pattern: "^[imsu]*$" })),
        scope: Type.Optional(Scope),
    }),
    Strict({
        type: Type.Union([Type.Literal("tool_called"), Type.Literal("tool_not_called")]),
        name: NonEmpty,
        args_match: Type.Optional(Type.Object({})),
    }),
]);

export const RubricExample = Strict({
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
    origin: Type.Union([Type.Literal("observed"), Type.Literal("written")]),
    text: NonEmpty,
    note: Type.Optional(Type.String()),
});

export const Rubric = Strict({
    question: NonEmpty,
    pass: NonEmpty,
    fail: NonEmpty,
    edge_cases: Type.Optional(Type.Array(NonEmpty)),
    // 至少一个取自原出错输出的"违反"例子；出处由 lint 核对。
    examples: Type.Array(RubricExample, {
        minItems: 1,
        contains: Type.Object({ verdict: Type.Literal("fail"), origin: Type.Literal("observed") }),
    }),
    scope: Type.Optional(Scope),
});

export const Requirement = Strict({
    id: Type.String({ pattern: "^[A-Za-z0-9_-]+$" }),
    text: NonEmpty,
    // 原要求都是必过条件，没有加分项。
    required: Type.Literal(true),
    // 出处必须是截止点之前某条消息的原文片段。
    source: Strict({ message: Type.Integer({ minimum: 0 }), quote: NonEmpty }),
    checks: Type.Optional(Type.Array(Check)),
    rubric: Rubric,
});

export const Producer = Strict({
    name: NonEmpty,
    version: NonEmpty,
    method: Type.Optional(Type.String()),
});

const Combine = Strict({ rule: Type.Literal("required_then_threshold") });

const scoringBody = {
    combine: Combine,
    requirements: Type.Array(Requirement, { minItems: 1 }),
};

export const InlineScoring = Strict({
    label: Type.Optional(Type.String()),
    producer: Type.Optional(Producer),
    ...scoringBody,
});

// ---------- 诊断与来源 ----------

export const Diagnostic = Strict({
    observed: AssistantMessage,
    violates: Type.Array(NonEmpty, { minItems: 1 }),
    followup: Type.Optional(Type.Array(Message)),
    labels: Type.Optional(
        Type.Array(Strict({ taxonomy: NonEmpty, label: NonEmpty, primary: Type.Optional(Type.Boolean()) })),
    ),
    notes: Type.Optional(Type.String()),
});

const Purpose = Type.Union([Type.Literal("improvement"), Type.Literal("validation")]);

export const Provenance = Strict({
    source: Strict({
        kind: Type.Literal("session"),
        reference: NonEmpty,
        group_key: NonEmpty,
    }),
    purpose: Purpose,
    producer: Producer,
    created_at: Timestamp,
    limitations: Type.Optional(Type.Array(Limitation)),
    transforms: Type.Optional(Type.Array(Transform)),
});

// 每条要求的期望依据（docs/long-trajectory-slicing.md §5、§7）。
// 没有记录的要求按 instruction 处理，兼容此前保存的案例。
export const RequirementBasis = Type.Union([
    Strict({ basis: Type.Literal("instruction") }),
    Strict({ basis: Type.Literal("evidence"), refuted_by: Type.Optional(Type.Array(NonEmpty)) }),
    Strict({
        basis: Type.Literal("norm"),
        norm: Type.Union([Type.Literal("N1"), Type.Literal("N2"), Type.Literal("N3"), Type.Literal("N4")]),
        norms_version: Type.Integer({ minimum: 1 }),
        refuted_by: Type.Optional(Type.Array(NonEmpty)),
    }),
]);

// CasePick 私有信息，Detroit 原样保留、可以忽略。
export const CasepickExtension = Strict({
    cutoff_entry: NonEmpty,
    host_version: Type.Optional(NonEmpty),
    rubric_edited: Type.Optional(Type.Boolean()),
    confirmed_at: Type.Optional(Timestamp),
    // 长程切片所属的主案例；同时作为 provenance.source.group_key。
    issue_id: Type.Optional(Type.String({ pattern: "^issue_[A-Za-z0-9-]+$" })),
    requirements: Type.Optional(Type.Record(Type.String({ pattern: "^[A-Za-z0-9_-]+$" }), RequirementBasis)),
});

const Extensions = Strict({ "x-casepick": Type.Optional(CasepickExtension) });

// ---------- 三种文档 ----------

export const CaseDocument = Strict({
    schema: Type.Literal("detroit.case/v2"),
    id: CaseId,
    revision: Revision,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    suite: Type.Optional(NonEmpty),
    meta: Type.Optional(Type.Record(Type.String(), Type.String())),
    task: Task,
    scoring: InlineScoring,
    diagnostic: Diagnostic,
    provenance: Provenance,
    digests: Strict({ task: Digest, scoring: Digest }),
    extensions: Type.Optional(Extensions),
});

// 已确认的案例只改了评分时，单独导出的评分文档。
export const ScoringDocument = Strict({
    schema: Type.Literal("detroit.scoring/v2"),
    id: Type.String({ pattern: "^casepick:[A-Za-z0-9][A-Za-z0-9._/-]*$", maxLength: 256 }),
    revision: Revision,
    label: Type.Optional(Type.String()),
    target: Strict({ case_id: CaseId, task_digest: Digest }),
    producer: Type.Optional(Producer),
    ...scoringBody,
    digests: Strict({ scoring: Digest }),
    extensions: Type.Optional(Extensions),
});

export const DatasetEntry = Strict({
    case: Strict({ id: CaseId, revision: Revision, task_digest: Digest }),
    scoring: Type.Array(
        Strict({
            id: Type.Optional(Type.String({ minLength: 1 })),
            revision: Type.Optional(Revision),
            digest: Digest,
        }),
        { minItems: 1 },
    ),
    weight: Type.Optional(Type.Number({ minimum: 0 })),
    suite: Type.Optional(NonEmpty),
});

export const DatasetDocument = Strict({
    schema: Type.Literal("detroit.dataset/v2"),
    id: Type.String({ pattern: "^casepick:[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 256 }),
    revision: Revision,
    name: NonEmpty,
    purpose: Purpose,
    entries: Type.Array(DatasetEntry, { minItems: 1 }),
    digests: Strict({ dataset: Digest }),
});

export type Message = Static<typeof Message>;
export type AssistantMessage = Static<typeof AssistantMessage>;
export type ToolCall = Static<typeof ToolCall>;
export type Task = Static<typeof Task>;
export type Check = Static<typeof Check>;
export type Rubric = Static<typeof Rubric>;
export type Requirement = Static<typeof Requirement>;
export type InlineScoring = Static<typeof InlineScoring>;
export type Diagnostic = Static<typeof Diagnostic>;
export type Provenance = Static<typeof Provenance>;
export type RequirementBasis = Static<typeof RequirementBasis>;
export type CasepickExtension = Static<typeof CasepickExtension>;
export type CaseDocument = Static<typeof CaseDocument>;
export type ScoringDocument = Static<typeof ScoringDocument>;
export type DatasetDocument = Static<typeof DatasetDocument>;

export interface SchemaError {
    path: string;
    message: string;
}

// 返回全部结构错误，空数组表示通过。
export function schemaErrors(schema: TSchema, value: unknown): SchemaError[] {
    return [...Value.Errors(schema, value)].map(({ path, message }) => ({ path: path || "/", message }));
}
