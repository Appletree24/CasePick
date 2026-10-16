# CasePick 技术设计

> 版本 2026-10-12（第二版）。案例格式改为直接采用 Detroit 评测集格式 `detroit.case/v2`；此前当天的版本加入了评审标准（rubric）。更早的版本见 git 历史。
> `casepick-plan.md` 中的自动采集和 Harness 内评测已经放弃，以本文为准。
> 2026-10-13 实现补充：同一入口支持 Pi 和 OMP。会话重建统一调用宿主的 `buildSessionContext`，截止点为原出错回复的父节点；不依赖 Pi 独有的 `buildSessionProjection`。OMP callable 工具 schema 通过 `toJsonSchema()` 导出；案例自身的 schema 构造和校验固定使用本地 TypeBox 子路径，避免宿主兼容层替换裸包入口后混用两套 schema。OMP 基础提示与 developer 指令合并为 approximate 的 `task.system`，不改变 Detroit v2 的消息角色集合。
> DSH 适配补充：保留 Pi/OMP 原入口，新增 DSH 原生 Host 与 Web Client 入口。案例生成、长程问题、核对与存储共用；各宿主自己的历史重建、模型调用、设置与交互协议见第 13 节。

## 1. 一句话

CasePick 是一个 Pi / OMP / DSH 插件：**把你在日常使用中遇到的 Agent 犯错，整理成可以直接拿去评测的高质量案例文件。**

它只负责"生产数据"。拿这些案例去跑模型、打分、做对比，是下游评测平台 [Detroit](https://github.com/Appletree24/Detroit) 的事，插件不做。案例格式以 Detroit 定义的评测集格式协议为准（Detroit `docs/10-dataset-format.md`），CasePick 直接产出这种格式。

一条案例的核心是三样东西：模型当时看到的输入、它该做到的要求、以及**下游评审模型照着就能判对错的评审标准（rubric）**。

## 2. 为什么要做

用 Agent 干活时，经常出现这种情况：你明确说过"只输出 JSON"，它还是在前面加了一段解释；你说过"别动测试文件"，它改了；你纠正它，它改好了，对话继续。

这些瞬间是最有价值的评测素材：真实、和你的使用场景强相关、并且已经有人（你）判断过对错。但它们几乎从来没被留下来，因为：

- 整理一条像样的案例很麻烦：要找出当时的上下文、裁掉后面的纠正、写清楚期望、附上证据。
- 随手复制粘贴出来的"案例"质量很差：经常把后面的纠正混进输入里（等于把答案告诉了模型），或者把用户后来才提的要求当成模型当时就该知道的。
- 真实要求千奇百怪，大多数没法写成程序检查。只写一句"应该做得更好"，下游评审模型判出来的结果也不可靠。

CasePick 要做的，就是把这件事的成本降到"扫一下、看一眼、点确认"，同时保证产出的数据经得起推敲。

## 3. 范围

**做：**

- 从 Pi / OMP / DSH 的会话历史里找出疑似犯错的地方（候选）。
- 把候选整理成结构化案例：模型当时看到的输入、它该做到什么、它实际做了什么、依据是什么。
- 为每条要求写评审标准（rubric），让下游的 LLM 评审（LLM-as-judge）或人工评审能稳定地判定；能程序化检查的要求额外附上约束。
- 长程任务：把跨多轮、多个会话的同一个问题整理成主案例，从中切出可以独立评测的题（[长程任务的案例切片](long-trajectory-slicing.md)）。
- 用模型辅助起草和切片，默认用当前会话的模型、思考等级 low；模型只提建议，程序核对，人确认。
- 用本地检查保证案例质量，让用户在当前宿主里集中审阅和确认。
- 本地保存，导出成 Detroit 评测集格式（`detroit.case/v2` 的 JSONL）。

**不做：**

- 不运行被测模型，不运行评审模型，不打分，不做模型间对比，不出通过率。
- 不在后台持续读取对话内容、不自动调用模型。所有读取和模型调用都由用户主动触发。
- 不恢复项目运行环境（文件系统、数据库、网络服务），只如实记录案例依赖什么。
- 不做上传、账号、Web UI 和常驻服务。

## 4. 术语

| 词 | 含义 |
| --- | --- |
| 候选 | 扫描时找到的"这里可能有模型犯错"的位置，还没整理，也不一定真的是错 |
| 案例 | 整理完成、用户确认过的一条评测数据 |
| 出错消息 | 犯错的那条 assistant 消息（可以是文字回答，也可以是一次工具调用） |
| 截止点 | 出错消息本身。它**之前**的内容构成输入，它和它之后的内容都不进输入 |
| 原要求 | 截止点之前、用户或系统明确提出过、被出错消息违反的要求 |
| 期望依据 | 一条要求从哪来：`instruction`（用户或系统原话）、`evidence`（截止点之前和出错回复矛盾的事实）、`norm`（规范表里的工作规范）。出处都必须在截止点之前 |
| 主案例 | 长程任务里的一个待解决问题，可以跨多个会话，只在本地使用；从它切出的每道题是一条普通案例 |
| 评审标准（rubric） | 每条原要求附带的判定说明：判定问题、通过和违反的标准、边界情况、例子。给下游评审模型或人看 |
| 约束 | 可以由程序检查的期望，比如"必须是合法 JSON""不能调用 `write` 修改 `tests/` 下的文件"。可选，是 rubric 之外的补充 |
| 评审方式 | `program`：至少一条约束能程序化判定；`rubric`：只能靠评审模型或人按 rubric 判定。两者都要有完整 rubric。只在界面上显示，不单独存字段，由要求里有没有约束推出 |

## 5. 用户怎么用

一个完整的例子。

**1）正常对话中犯错。** 第 12 条消息里你说："把结果整理成 JSON，只输出 JSON，别加解释。"第 13 条模型回答："好的，以下是整理结果：\`\`\`json {...} \`\`\`"。第 14 条你说："我说了只要 JSON。"

这时你什么都不用做。想留个记号也可以输入 `/casepick mark`，它只记下"这里有问题"，不读取也不复制内容。

**2）有空时扫描。** 输入 `/casepick`。插件读取当前会话分支的历史，几秒内列出候选：

```
候选（当前分支，共 86 条消息，全部可读）
 [1] #13  纠正语："我说了只要 JSON"         疑似：违反已有要求
 [2] #31  工具报错后用户介入                 疑似：环境问题
 [3] #47  你标记的位置
```

**3）整理。** 选中 [1]，选择"用模型起草"（需要先在 `/casepick config` 配好起草用的模型；不配的话可以手填）。插件生成草稿：

```
标题     要求只输出 JSON，回答却带了说明文字
截止点   #13（输入 = #1 ~ #12）
原要求   r1 "只输出 JSON，别加解释"    ← 引自 #12
评审标准 r1
  问题   回答是否整体只是一个 JSON 值，JSON 之外没有任何文字？
  通过   去掉首尾空白后，整个回答能被解析为一个 JSON 值
  违反   JSON 前后出现说明、寒暄、标题或 Markdown 代码块标记
  边界   首尾空白不算违反；JSON 字符串值内部的文字不算"解释"
  反例   "好的，以下是整理结果："      ← 引自原出错输出
约束     r1 → json_only
实际     #13 以"好的，以下是整理结果："开头
检查     ✓ 原要求出现在截止点之前
         ✓ 输入中不含 #13 及之后的内容
         ✓ rubric 字段齐全，反例确实出自原出错输出
         ✓ 约束对实际输出判定为"违反"（说明约束写得对）
评审方式 program
```

你看一眼没问题，按确认。不对就改，或者丢弃。

**4）导出。** 攒够一批后 `/casepick export`，确认路径，得到一份 Detroit 评测集（`cases.jsonl` 加 `dataset.json`），直接导入 Detroit。

整个过程中，插件不会往当前对话里插入任何内容，也不会打断你正常使用 Pi。

## 6. 什么是一条好案例

这是整个设计的核心。下面每一条都对应一项本地检查（第 8 节④），检查不通过的案例不能确认。

1. **输入就是模型当时看到的东西。** 截止点之前的消息按原顺序、原文保留。如果当时发生过历史压缩，输入里就是压缩摘要加后续消息，和模型当时的视角一致，不能用压缩前的原文"还原"。
2. **输入里没有答案。** 出错消息、用户的纠正、后续修正都不进输入。这一点由截止点机制保证，并在确认前再检查一次。
3. **期望有出处。** 每条原要求都要引用截止点之前某条消息的原文。用户后来才补充的要求，不能当成模型当时就该遵守的。
4. **期望是一条条独立的要求**，不是一段笼统的"应该做得更好"。
5. **每条要求都有能直接用的评审标准。** 不懂这次会话的评审模型，只看 `task`、被测输出和 rubric，就能给出稳定的判定。具体写法见第 7 节"评审标准"。
6. **rubric 能判出原来的错。** rubric 里至少有一个"违反"的例子取自原出错输出的原文，证明这份标准针对的就是这次犯错。
7. **能检查的尽量再写成约束，并且约束要能抓到原来的错。** 把约束套在原出错输出上，结果必须是"违反"。否则说明约束写错了，或者这里其实没犯错。
8. **能脱离本机独立使用。** 导出文件不依赖本机路径、原会话文件或 Pi 本身。
9. **局限要说清楚。** 系统提示是否拿到了、工具定义是不是当时的版本、依赖了哪些拿不到的环境，都要写明，不能假装完整。

**评审方式**（随案例导出，方便下游选择评审手段）：

| 评审方式 | 条件 |
| --- | --- |
| `program` | 满足 1–9，并且至少一条约束能程序化判定原输出违反。下游可以只跑约束，也可以和 rubric 评审一起用 |
| `rubric` | 满足 1–6、8、9，没有有效约束，由评审模型或人按 rubric 判定 |

两种方式没有优劣之分。真实使用中的要求大多没法写成程序检查，`rubric` 是常态，不是次品；它对 rubric 质量的要求反而更高。达不到 `rubric` 条件的不能确认，只能留在候选里或丢弃。

## 7. 案例数据结构

CasePick 不再定义自己的交换格式，案例直接采用 Detroit 评测集格式协议的 `detroit.case/v2`（Detroit 仓库 `docs/10-dataset-format.md`，JSON Schema 在 `schemas/detroit-v2.schema.json`）。完整示例见 Detroit 的 `examples/datasets/v2/casepick-inline/`。本节只说明 CasePick 怎么填这个格式，以及 CasePick 自己比协议更严格的地方。

### 字段怎么填

| `detroit.case/v2` 字段 | CasePick 的取值 |
| --- | --- |
| `id` / `revision` | `casepick:<案例 ID>`；修改已确认的案例时 `revision` 加 1 |
| `title`、`meta` | 草稿标题；`meta` 可以带 `domain`、`skill` 等标签 |
| `task.kind` / `horizon` / `start` | 固定为 `agent` / `next_message` / `current`：只判出错位置的下一条回复，不执行工具 |
| `task.messages` | 截止点之前的消息，OpenAI messages 格式（第 9 节转换），不含 system |
| `task.system` | 拿不到时 `{ "status": "missing", "content": null }` |
| `task.tools` | `source: "approximate"`，定义取自扫描时的配置 |
| `task.environment` | 不涉及文件和外部状态时 `kind: "none"`；涉及时 `kind: "unavailable"`，并在 `limitations` 里说明 |
| `task.output.format` | 由约束推出：`json_only` 对应 `json`，`tool_*` 对应 `tool_calls`，其余为 `text` |
| `scoring`（内联默认评分） | 原要求、出处引文、rubric、约束（协议里叫 `checks`）；`combine` 固定为 `required_then_threshold`，所有原要求都是 `required: true` |
| `diagnostic` | `observed`：原出错消息；`violates`：它违反的要求；`followup`：用户的纠正；`labels`：按 Detroit 失败分类体系的归因（可选） |
| `provenance.source` | `kind: "session"`；`reference` 为会话 ID 哈希加截止点 entry ID；同一个会话拆出的案例共用 `group_key` |
| `provenance.purpose` | 默认 `improvement`，导出时可以按批次改为 `validation`（第 11 节） |
| `provenance.producer` | `{ "name": "casepick", "version", "method" }`，`method` 为 `model:<模型>`、`rule:<规则>@<版本>` 或 `manual` |
| `provenance.limitations` / `transforms` | 系统提示缺失、工具定义近似、脱敏、截断、丢弃 thinking、省略图片等 |
| `digests` | 按协议 §4 计算 `task` 和 `scoring` 两个摘要 |
| `extensions["x-casepick"]` | CasePick 私有信息：`cutoff_entry`（宿主 entry ID；DSH 为 `dsh:<seq>`）、`host_version`、`rubric_edited`、`confirmed_at` 等，Detroit 原样保留、可以忽略 |

几点说明：

- **`source.message` 是 `task.messages` 的下标**，`quote` 必须是那条消息的原文片段。Detroit 导入时会重新核对，不需要访问原会话。
- **`diagnostic` 和 `task` 严格分开。** `diagnostic` 永远不进入被测模型的输入；rubric 例子里引用的原出错片段也只给评审看。
- **改 rubric 或约束不改题。** 只改评分时 `digests.task` 不变，Detroit 能识别出这是同一道题的新评分，用已有的模型输出重新判分，不重跑被测模型。
- **CasePick 不再输出 `quality` / `judge_mode`、单一 `hash` 和 `casepick.case/v1`。** 评审方式由有没有约束推出；摘要拆成两个。

### CasePick 比协议更严格的地方

协议允许的东西，CasePick 产出时收得更紧：

| 协议的要求 | CasePick 的要求 |
| --- | --- |
| 要求有 `rubric` 或 `checks` 之一即可 | 每条要求**都必须有 rubric**，约束是额外的 |
| `rubric.examples` 可选 | 至少一个 `origin: observed` 的 `fail` 例子，取自原出错输出 |
| `source` 可选 | 每条要求都必须有 `{ message, quote }` 出处，且所引消息在截止点之前 |
| `diagnostic` 可选 | 必须有 `observed` 和 `violates` |

### 评审标准（rubric）

rubric 是案例质量的主要载体。下游评审模型能不能判得准、判得稳，几乎全看 rubric 写得好不好。字段按协议 §7.5：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `question` | 是 | 一个能回答"是 / 否"的判定问题，"是"表示通过 |
| `pass` | 是 | 怎样算通过，描述输出里能直接观察到的特征 |
| `fail` | 是 | 怎样算违反，同上 |
| `edge_cases` | 否 | 容易误判的情况怎么判，一条一句 |
| `examples` | 是（CasePick） | 至少一个来自原出错输出的 `fail` 例子；`pass` 例子可选 |
| `scope` | 否 | 判定看哪部分输出：`final_text`（默认）、`all_text`、`tool_calls` |

`examples[].origin` 的取值：

- `observed`：原出错输出的原文片段，lint 会核对它确实出现在 `diagnostic.observed` 里（工具调用按参数 JSON 字符串核对）。
- `written`：人或起草模型写的示意例子，不需要核对出处，但不能标成 `observed`。

这些 `observed` 例子都是人确认过的"违反"样本，Detroit 可以直接拿来做 Judge 校准的人工标注集（Detroit `docs/07-methodology.md` §3）。

**写 rubric 的规则**（起草提示词和审阅界面都按这些规则引导；能确定性检查的写进 lint）：

1. **只判这一条要求。** rubric 的范围不能超过 `text` 和 `source.quote`，不能顺带判别的要求，也不能夹带用户后来才补充的要求。
2. **只依赖评审能看到的东西。** 评审模型只看得到 `task`、被测输出和 rubric。判定需要的背景信息（比如"测试文件指 `tests/` 目录"）要么已经在 `task.messages` 里，要么写进 rubric，不能依赖 `diagnostic.followup` 或原会话。
3. **描述可观察的行为，不描述意图。** "回答里出现了 X""调用了 Y 工具并修改了 Z 路径"，而不是"模型没有理解用户的意思"。
4. **二元判定。** `pass` 和 `fail` 合起来覆盖所有情况；拿不准的情况写进 `edge_cases` 给出判法，不要留"视情况而定"。
5. **不惩罚无关的差异。** 如果被测输出做对了这条要求、但在别的方面和原回答不同，应该判通过。
6. **语言和原要求一致。** 原要求是中文，rubric 就用中文写。

### 评审由 Detroit 负责

评审的输入输出格式（`detroit.judge/v1`：一次判一条要求，结果是 `pass` / `fail` / `unknown`，附证据片段）、组合规则、用哪个评审模型和提示词，都由 Detroit 定义和执行（协议 §7.4、§7.6）。CasePick 不再随导出附带评审提示词模板；阶段 0 冒烟脚本里用的评审提示词只是开发工具（第 14 节）。

### 约束类型

约束是 rubric 之外的补充，只在要求本身就能被精确判定时使用。CasePick 只产出协议登记表（§7.3）里的离线检查，因为 `next_message` 题不执行工具，用不到 `command`、`tests` 这类在线检查：

| 类型 | 含义 | 参数 |
| --- | --- | --- |
| `json_only` | 输出整体是合法 JSON | — |
| `contains` / `not_contains` | 输出包含 / 不包含某段文字 | `text`、`ignore_case` |
| `regex` / `not_regex` | 输出匹配 / 不匹配正则（ECMAScript 语法） | `pattern`、`flags` |
| `tool_called` / `tool_not_called` | 调用了 / 没调用某工具，可限定参数 | `name`、`args_match` |

协议里的 `json_schema` 先不产出（需要用户手写 schema）。阶段 0 统计样板案例里实际需要哪些约束，确实需要再加；需要协议里还没有的类型时，先向 Detroit 提出登记。

每种约束类型配一份默认 rubric 模板（比如 `json_only` 对应 Detroit 示例里的 rubric），规则起草和手填时自动带出，保证约束和 rubric 判的是同一件事。

已实现 `core/checks.ts` 的 `evaluateCheck(check, observed)`：输入现有 `Check` 和单条 `AssistantMessage`，返回 `{ verdict: "pass" | "fail" | "unknown", reason }`。只验证录制输出，不执行工具、不调用模型、不合并要求级评分；调用方负责输入结构校验。

- 单条 `next_message` 的 `final_text` 和 `all_text` 都读取 `content`；`null` 按空文字处理，不混入工具参数。文字检查指定 `tool_calls` 时返回 `unknown`：Detroit 尚未定义其序列化规则。
- `json_only` 接受所有合法 JSON 值，但不剥离解释或 Markdown 代码围栏。忽略大小写采用 ECMAScript `toLowerCase()`；正则仅接受 `i/m/s/u`，非法表达式或重复 flags 返回 `unknown`。
- `args_match` 的本地约定：对象递归匹配自有属性子集；数组按完整值匹配，保留长度与顺序。Detroit 目前只规定“参数子集匹配”，更细的跨实现语义仍需对齐。
- 不限定参数时仅匹配工具名；限定参数时，同名调用的参数若不是合法 JSON 对象，且不存在其他确定匹配，返回 `unknown`。任一确定匹配优先；无匹配且无不确定项时，`tool_called` 失败、`tool_not_called` 通过。

## 8. 生产流程

```
Pi 会话文件
   │ ① 读取当前分支（用户执行 /casepick 时）
   ▼
消息列表（带 entry ID、父子关系、压缩信息）
   │ ② 本地规则找候选
   ▼
候选列表 ──③ 用户选中──► 起草（规则 / 模型 / 手填）
                              │ ④ 本地检查
                              ▼
                         草稿 ──⑤ 用户审阅、修改、确认──► 案例库
                                                          │ ⑥ 导出
                                                          ▼
                                       Detroit 评测集（cases.jsonl + dataset.json）
```

### ① 读取历史

- 只读当前活动分支：从当前叶子节点沿父链回溯到根，不读其他分支。
- 尽量通过 Pi 扩展 API 读取；如果 API 不够用，退而读取会话 JSONL 文件。具体用哪种方式在阶段 1 开工时验证（第 17 节）。
- 遇到压缩：记录压缩点。这样后面构建输入时，可以还原出模型在截止点那一刻看到的上下文（摘要加压缩后保留的消息）。
- 单次读取设上限（默认 2000 条消息或 20 MB）。超出时提示用户，并且明确告诉用户哪些没读到，不偷偷截断。
- 读取和解析分批进行，避免卡住 Pi 界面。

### ② 找候选

纯本地规则，不调用模型。每个候选记录：信号类型、疑似出错消息、疑似纠正消息、规则的初步判断。

| 信号 | 规则 | 初步判断 |
| --- | --- | --- |
| 纠正语 | assistant 消息之后紧跟的 user 消息里出现"不对 / 不是 / 我说过 / 别 / 不要 / 重来 / 撤销 / no / wrong / I said / revert"等 | 待定 |
| 格式冲突 | 之前出现过"只输出 JSON / 用中文 / 不要代码块"这类可识别要求，之后的 assistant 输出违反了 | 违反已有要求 |
| 工具报错后介入 | 工具结果报错，随后用户发言 | 偏向环境问题 |
| 用户中断 | assistant 回合被用户中止（如果 Pi 会话里有记录） | 待定 |
| 书签 | `/casepick mark` 记下的位置 | 待定 |

规则宁可多报，不要漏报。漏掉的候选再也找不回来，多报的候选用户扫一眼就能丢掉。

### ③ 起草

用户对每个候选选择一种方式：

**手填。** 插件预填截止点、输入和一份空的 rubric 模板（字段齐全、带填写提示），期望、rubric 和约束由用户写。选了约束类型时自动带出该类型的默认 rubric。

**规则起草。** 只对"格式冲突"这类规则本身就能看懂的候选有效：直接填好原要求引用、对应约束（比如 `json_only`）和该约束的默认 rubric，并把原出错输出中违反的片段填为 `fail` 例子。其他类型的候选，规则只负责定位截止点。

**模型起草。** 质量的主要来源，尤其是 rubric。流程：

1. 把候选附近的消息编号后发给起草模型，包括截止点之前的相关消息、出错消息和纠正消息。纠正消息只用来帮模型理解哪里错了，不会进入案例输入，也不能成为 rubric 的依据（第 7 节规则 1、2）。
2. 要求模型返回结构化结果：截止点是哪条消息、犯错类型（违反已有要求 / 需求补充 / 目标变化 / 环境问题 / 说不清）、原要求（消息编号加原文引用）、每条要求的 rubric（含至少一个取自原出错输出的 `fail` 例子）、建议的约束、环境依赖。起草提示词里写明第 7 节的 rubric 规则，并附 2–3 个阶段 0 样板作为示范。
3. 本地逐项核对模型的输出（见④）。核对不过的字段直接清空，标成"需要人工补"，不会让模型重试，避免产生额外费用。
4. 犯错类型不是"违反已有要求"的候选，草稿会标明，默认建议丢弃。

**起草模型怎么选。** 起草模型从宿主（Pi / OMP）已经配置好的模型里选，凭据也由宿主提供，CasePick 不保存任何密钥。

| 配置 | 取值 | 默认 |
| --- | --- | --- |
| `drafting.model` | `{ "mode": "follow_current" }`：跟随当前会话的模型；`{ "mode": "fixed", "provider", "id" }`：固定某个模型；`{ "mode": "off" }`：不用模型，只手填和规则起草 | `follow_current` |
| `drafting.reasoning` | 思考等级：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` | `low` |
| `drafting.max_output_tokens` | 单次请求的输出上限 | 8000 |
| `drafting.timeout_s` | 单次请求超时 | 120 |
| `drafting.debug` | 是否展示模型辅助的请求、原始回复、解析和核对诊断 | `false` |

- **OMP 的模型角色**：OMP 支持自定义模型角色。在 `~/.omp/agent/config.yml` 的 `modelTags` 里声明 `casepick` 角色后，可以在 `/model` 面板里给它可视化地指派模型。`follow_current` 模式下，CasePick 先用 `ctx.models.resolve("@casepick")` 找这个角色，找到就用它，找不到才跟随当前会话的模型；思考等级仍按 `drafting.reasoning`。Pi 没有模型角色，不受影响。
- **OMP 设置 → Plugins 分区**：`package.json` 的 `omp.settings` 声明了 `draftModel`（文本：留空、`current`、`off`、`@角色` 或 `provider/id`）、`reasoning`（固定选项，默认 low）、`maxOutputTokens`、`timeoutSeconds` 和 `debug`（布尔开关，默认关闭）。用 `omp plugin link <CasePick 目录>` 装成插件后，这一项会出现在 Plugins 分区。通过宿主插件设置 API 读取并合并全局和项目覆盖（项目优先），每次操作重新读取。**显式设置的项覆盖 `/casepick config` 的对应项，包括 `debug: false`**，未设置的沿用 `/casepick config`。`/casepick config` 会列出哪些项被覆盖；debug 被覆盖时提示去 Plugins 切换。Plugins 分区不能列出可用模型，所以 `draftModel` 是文本框；要下拉选模型，用上面的 `@casepick` 角色。
- **默认值的含义**：当前会话用的是 Astra，起草就用 Astra，思考等级 low。"跟随"在每次发起起草时取当前模型，不在配置里写死；用户中途切换了会话模型，下一次起草跟着变。
- **思考等级的处理**：模型不支持思考时不传这个参数，界面显示"该模型不支持思考等级"；模型不支持所选等级时，取它支持的最接近的较低等级，没有较低的就取最接近的较高等级，并在界面上显示实际使用的等级。
- **凭据**：发请求时用 `ctx.modelRegistry.getApiKeyAndHeaders(model)` 取凭据，不落盘；`hasConfiguredAuth(model)` 为假时不发送，提示用户先在宿主里配置。
- **怎么调用**：用宿主提供的 `completeSimple(model, context, { apiKey, headers, reasoning, maxTokens, signal })`，不传工具，因为起草模型不需要执行任何操作。不调用 `pi.setModel` / `setThinkingLevel`，不影响当前会话的模型和思考等级，也不往会话里插消息。
- **跟随当前模型不等于同意外发。** 会话本来就在用这个模型，但起草会发出别的内容（比如其他会话的材料），所以照样按第 10 节确认。
- 不自动重试，不自动换模型。模型返回的内容解析失败时，对应字段标为需要人工补。
- **在哪里配置**：`/casepick config` 的"起草模型"一项（第 12 节）。每次起草前的一行确认里都显示实际使用的模型和思考等级，比如"将用 Astra · low 发送 5 个请求"。
- **Debug 模式**：`drafting.debug` 或 Plugins 的 `debug` 开启时，每个模型辅助请求结束后展示可选面板：脱敏后的实际请求及命中、完整原始回复、解析结果、核对通过数量与拒绝原因；显示模型、实际思考等级、输出上限、超时、停止原因和用量。空列表明确标为“模型返回空候选列表”，不把它解释为“已确认没有问题”；调用或解析失败也能查看已取得的信息。仅在当前调用的界面展示，不持久化内容，不收集调用凭据，原始回复可能含敏感内容。关闭时不构建或展示调试面板，不增加模型调用，也不改变核对规则。

**长程任务的模型辅助**（标注证据性质、提出候选切片、提出主案例归并）用同一套配置，见 [长程任务的案例切片](long-trajectory-slicing.md) 第 8 节。

### ④ 本地检查（lint）

起草后、确认前、导出前各跑一次。全是确定性检查，毫秒级完成：

| 检查 | 不通过时 |
| --- | --- |
| `task.messages` 只包含截止点之前的消息 | 阻止确认 |
| 每条原要求的 `quote` 确实出现在所引用消息的原文里 | 阻止确认 |
| 被引用的消息在截止点之前 | 阻止确认：这是"后来才提的要求" |
| 工具调用和工具结果一一配对，顺序和原文一致 | 阻止确认 |
| 至少一条原要求 | 阻止确认 |
| 每条原要求都有 rubric，`question`、`pass`、`fail` 非空 | 阻止确认 |
| 每个 rubric 至少有一个 `origin: observed` 的 `fail` 例子 | 阻止确认 |
| `origin: observed` 的例子确实出现在原出错输出里 | 阻止确认：这条例子被清空 |
| 要求和 rubric 里有一段只在截止点之后出现、截止点之前的输入和原出错输出里都没有的连续文字（默认 12 个字符，中日韩文字为主时 8 个字）。截止点之后包括同一会话的后续全部消息，长程切片还包括主案例里更晚的证据和最终结论 | 阻止确认 |
| 要求的期望依据（`x-casepick.requirements`）对应不到要求、规范版本不一致，或 `evidence` / `norm` 依据引用了助手自己的回复 | 阻止确认 |
| rubric 各字段超出长度建议（`question` 200 字，其他 500 字） | 警告：评审标准过长，容易判不稳 |
| 每条约束套在原出错输出上都判定为"违反" | 该约束标红；没有任何有效约束时，评审方式为 `rubric` |
| 脱敏没有改动被引用的原文和 `observed` 例子 | 阻止确认，提示用户处理 |
| `task.messages` 和 `task.tools` 能序列化成合法的 Chat Completions 请求体 | 阻止确认 |
| 整条案例通过 Detroit JSON Schema 校验，两个摘要和重新计算的结果一致 | 阻止确认（只在确认前和导出前检查） |

注意：约束检查只把约束套在**原来那条出错输出**上，用来检验数据本身写得对不对，不调用任何模型，不属于评测。rubric 只做结构和出处检查，插件不调用评审模型去验证 rubric（是否提供手动的 rubric 自检见第 18 节）。

已实现的核心接口：

- `core/rubric.ts`：`emptyRubric()` 返回手填草稿，填写提示单独由 `rubricHints` 提供；`rubricForCheck(check, observed?)` 为七种约束生成默认模板。只有 `evaluateCheck` 对原输出判为 `fail` 才预填原文反例，否则保留空例子等待人工填写。`rubricErrors(value)` 检查 schema 和纯空白字段，返回 `{ path, message }[]`。
- `core/lint.ts`：`lintCase(value, options?)` 返回 `{ valid, issues, checks, reviewMode, cutoffVerified }`。`issues` 包含严重级别、稳定错误码、JSON Pointer 路径和提示；`checks` 保留逐条约束结果，只有 `fail` 标为 `usable`，至少一条有效约束时 `reviewMode` 为 `program`。这些结果只供调用方使用，不新增交换格式字段。
- `options.stage` 默认为 `draft`，允许尚未填写完整的顶层信封和摘要；`confirm` / `export` 检查完整 CasePick schema（Detroit 的严格子集）及两个摘要。结构错误会先返回，正文结构通过后再检查跨字段关系。`valid` 仅表示当前阶段没有错误，警告仍需要审阅。
- 截止点核对需要调用方传入 `source: { entries: [{ id, message }], cutoffEntry }`，快照必须独立来自当前分支，并包含出错消息本身；消息应已完成格式转换、压缩上下文选择和与案例一致的脱敏。核对截止点前完整输入、出错消息及保存的截止点 ID，不能用待检查案例反向构造快照。`confirm` 缺少快照会报错；草稿和独立导出缺少快照会警告并返回 `cutoffVerified: false`，不宣称已验证原会话。
- 有脱敏记录时，确认还需提供 `beforeRedaction: { messages, observed }`，核对引文和原文例子在脱敏前的对应输入、输出中也存在。草稿或独立导出缺少此快照时返回未核对警告。导出流程若再次脱敏，应传入本次脱敏前快照。`followupMinLength` 可以调整后续内容重合警告的阈值，默认 12 个 Unicode 字符；长度建议分别为判定问题 200 字、其他文字字段 500 字。
- 两个模块均不修改案例。不存在的引文或反例由 lint 报出字段路径，清空字段和提示人工补充由起草 / 审阅流程处理。

### ⑤ 审阅与确认

- 审阅界面一次显示一条草稿：输入摘要（可展开全文）、原要求和出处、rubric、约束、实际输出、检查结果、评审方式。
- rubric 默认展开显示，因为它是最需要人看一眼的部分。编辑 rubric 时旁边显示原要求原文和原出错输出，方便对照。
- 操作：确认、编辑、丢弃、跳过。编辑输入时只能调整截止点，不能改写消息原文；脱敏是唯一例外，会记录在 `limitations.transforms` 里。
- 支持批量确认，但只会确认其中通过检查的条目；没通过的留在草稿里，并告诉用户原因。
- 修改已确认的案例会生成新版本（`version` 加 1），旧版本保留，导出默认取最新版本。

### ⑥ 导出

见第 11 节。

## 9. 消息格式转换

Pi 的消息格式和 OpenAI messages 不同，转换规则集中在一个模块里，有完整的单元测试：

| Pi 中的内容 | 转换为 |
| --- | --- |
| 用户文本 | `{role: "user", content}` |
| assistant 文本 | `{role: "assistant", content}` |
| assistant 工具调用 | `assistant.tool_calls[]`，保留原调用 ID |
| 工具结果 | `{role: "tool", tool_call_id, content}` |
| 思考内容（thinking） | 丢弃，记入 `transforms` |
| 图片 | 替换为 `[图片已省略]`，记入 `transforms`；rubric 需要写明依赖图片的部分无法判定 |
| 压缩摘要 | 作为一条 user 消息，内容格式与 Pi 构建上下文时一致（阶段 1 核实） |
| 超长工具输出 | 默认保留原文；用户可以选择截断，截断处标注 `[已省略 N 字符]` 并记入 `transforms` |

## 10. 隐私与外发

数据离开本机只有两种情况，都由用户主动触发：

**发给起草模型。**
- 第一次向某个模型（按 provider 加模型 ID 区分）发送前，展示一份完整的示例请求并要求确认。之后只要模型不变，每批只需一行确认（"将用 Astra · low 发送 5 个请求，约 30k tokens，确认？"），完整请求随时可以展开查看。跟随当前模型时同样适用。
- 用的是订阅制或 OAuth 登录的模型时，提示起草会占用同一份额度。
- 发送前做本地脱敏：API key、token、私钥、`.env` 内容、本机用户目录路径（替换为 `~`）。脱敏规则可以配置。
- 记录每次请求的 token 用量（以接口返回为准，拿不到就显示未知），不估算金额。
- 用户可以随时取消。还没发出的请求停止发送，已经发出的尽力中断，但无法保证服务方不计费，这一点会明确告诉用户。

**导出文件。** 导出前再跑一次脱敏和检查，展示条数、文件大小、脱敏命中情况和目标路径，用户确认后再写文件。rubric 里的例子同样经过脱敏。

插件日志只记录 ID、阶段、耗时、错误码和用量，不记录消息内容和凭据。

## 11. 存储与导出

### 本地存储

位置：`$XDG_DATA_HOME/casepick/`，未设置时为 `~/.local/share/casepick/`。目录权限 0700，文件权限 0600。

```
casepick/
  config.json       起草模型选择和思考等级（不含任何密钥）、脱敏规则、读取上限
  issues.jsonl      长程任务的主案例和证据时间线，只在本地使用，不导出
  cases.jsonl       所有草稿和案例版本，一行一个，只追加
  marks.jsonl       书签：会话 ID + entry ID + 时间，不含内容
  usage.jsonl       起草模型的调用记录：时间、模型、思考等级、token 用量，不含内容
  exports.jsonl     导出记录：时间、路径、包含的案例 ID、revision 和两个摘要、文件摘要
```

- **记录格式**：`cases.jsonl` 每行是一条 `detroit.case/v2` 结构的记录，状态（草稿、已确认、已删除）和版本历史放在 `extensions["x-casepick"]` 里。草稿可以不完整，所以只有已确认的记录保证通过 Detroit Schema 校验。

- **为什么用 JSONL 而不是数据库**：数据量小（个人使用，几百到几千条），追加写入简单可靠，人可以直接打开看，导出几乎等于复制。
- **写入**：追加一行。多个 Pi 窗口同时写也安全，因为每行很小，用追加模式打开文件即可。
- **删除**：在锁内把文件重写一遍（排除被删的案例），先写临时文件再原子替换。锁用 `mkdir` 实现，记录持有者 PID；只有删除和重写这类操作需要加锁。
- **候选不落盘。** 候选只在一次扫描期间存在于内存里；关掉 Pi 就没了，下次重新扫描即可。草稿和案例才写入 `cases.jsonl`。
- 删除只影响 CasePick 自己的数据，不动 Pi 的会话文件，也无法追回已经导出或发给起草模型的内容。

### 导出格式

`/casepick export` 默认导出所有已确认案例的最新版本，可以按评审方式、类型、时间筛选。

- **默认格式**：Detroit 评测集的内联打包方式（协议 §9），导出到一个目录：
  - `cases.jsonl`：每行一条 `detroit.case/v2`，评分内联；
  - `dataset.json`：一份 `detroit.dataset/v2`，列出本批案例的 ID、revision 和两个摘要。`purpose` 由导出时选择，默认 `improvement`；选 `validation` 时，案例自身的 `provenance.purpose` 也要是 `validation`，并且不能和以往导出的改进集共用 `group_key`，否则导出前提示。
- **只导出评分**：已确认的案例只改了 rubric 或约束（`digests.task` 没变）时，可以选择只导出 `scorings.jsonl`，每行一份 `detroit.scoring/v2`，用 `target.task_digest` 指向原题。Detroit 用它对已有结果重新评分，不需要重新导入题目。
- **`--format inspect`**：每行 `{id, input, target, metadata}`，可以直接作为 [Inspect AI](https://inspect.aisi.org.uk/) 数据集读取。`target` 是把各条要求和 rubric 渲染成的评分说明，可以直接交给 Inspect 的模型评分器；其余字段放进 `metadata`。

写入时先写临时文件，逐行用 Detroit JSON Schema 校验并核对摘要，通过后再改名为目标文件。目标已存在时要求用户确认覆盖。

## 12. 命令

| 命令 | 作用 |
| --- | --- |
| `/casepick` | 扫描当前分支，打开候选和草稿的审阅队列（主入口） |
| `/casepick mark [备注]` | 在当前位置留一个书签 |
| `/casepick cases` | 浏览、编辑、删除已有案例 |
| `/casepick export` | 导出 |
| `/casepick config` | 配置起草模型和思考等级、脱敏规则、读取上限 |

`/casepick config` 的界面：

```
CasePick 配置
  起草模型      跟随当前模型（现在是 Astra）
  思考等级      low
  脱敏规则      默认 5 条
  读取上限      2000 条消息 / 20 MB
```

- 选"起草模型"后列出：跟随当前模型（默认）、宿主里所有已配置凭据的模型（`ctx.modelRegistry.getAvailable()`，按 provider 分组）、不使用模型。
- 选"思考等级"后只列出所选模型支持的等级，默认 low。跟随当前模型时，按当前模型的能力列出。
- 保存到 `config.json`，文件权限 0600。

所有文字输入框（标题、要求、rubric、证据摘录、结论、会话路径等）都按回车提交、Shift+Enter 换行。OMP 上打开编辑框时传 `promptStyle: true`，否则默认是 Ctrl+Q / Ctrl+Enter 提交；Pi 的编辑框本来就是这样。

状态栏只显示进行中的操作和待审数量，不弹逐条通知。非交互模式（比如 print 模式）下拒绝执行，并说明原因。

命令解析在 `src/command.ts`，`src/extension.ts` 负责注册和分发。

**DSH 当前实现：** 左侧栏 CasePick 进入完整工作台，提供独立会话目录、时间线与截止点选择、内联审阅、案例/主问题资产库及设置子页。历史会话读取与工作流不要求活跃 Agent，不 resume/fork 源会话；`/casepick` 可定位接收命令的会话。模型找证据/提议切片/起草要求、Debug 与确认保存均在页内完成。DSH 执行命令本身仍可追加 `command/run` / `command/done`，不能将“不插入对话消息”表述为“原始日志绝不新增事件”。模型内容准备仍沿用现有分段策略，本次不实现长会话上下文预算设计。

**当前实现（2026-10-13，第二次更新）：** 新增起草模型配置（`/casepick config`，默认跟随当前模型、思考等级 low）、审阅时"用模型起草要求"、三种期望依据，以及"整理长程问题"入口（[长程任务的案例切片](long-trajectory-slicing.md)）。调用模型时，Pi 上用 `modelRegistry.streamSimple`，由宿主处理请求时的认证；宿主没有这个方法时（OMP），用 `getApiKeyAndHeaders` 加 `@earendil-works/pi-ai` 的 `completeSimple`。`mark`、`cases`、`export` 仍是待实现入口。

**当前实现（2026-10-13，第一次）：** `/casepick` 已打通本地生成流程：读取当前分支 → 选择候选或手动选择任意历史回复 → 规则起草 / 手动补充要求与 rubric → lint → 审阅确认 → 追加保存 `cases.jsonl`。不依赖起草模型，不向会话插入消息，不运行工具。`mark`、`cases`、`export`、`config` 仍是待实现入口。

- 读取使用宿主的 `getBranch()`；选定回复后用 `buildSessionContext(branch, cutoff.parentId)` 和 `convertToLlm()` 重建当时输入，保留压缩摘要、分支摘要及截止点之前的上下文编辑。不会把后来发生的压缩或编辑回溯应用到旧输入。超过 2000 条消息 / 20 MB 时停止并明确提示，不用截断历史生成案例。
- 本地信号包含用户纠正、JSON / 代码块格式冲突、工具报错后用户介入和异常中止。信号不等于错误结论；规则只对最近一条用户消息里的明确 JSON / 代码块要求预填草稿，选中后按实际输入重新计算出处。所有历史 assistant 回复都可手动选择。
- 审阅支持编辑标题、添加 / 编辑 / 删除要求、选择程序约束、填写 rubric 和环境依赖、查看完整输入与检查结果。输入及原出错输出保持快照原文；引用和反例必须能够逐字核对。返回候选后，本次扫描内已编辑的草稿仍保留；退出扫描后未确认草稿丢弃，暂不提供草稿持久化或已有案例版本管理。
- 确认时展示路径和大小，重新计算摘要并运行 `confirm` lint，要求错误清零且截止点核对通过，警告需由用户接受。保存位置为 `$XDG_DATA_HOME/casepick/cases.jsonl`，未配置时为 `~/.local/share/casepick/cases.jsonl`；目录权限 0700，文件权限 0600，追加写入使用独占锁避免多窗口记录交错。
- 本阶段保存的是本地原文，没有自动脱敏或对外发送。工具定义取扫描时配置并标为近似；系统提示只取会话保存的数据，中途更新的提示合并后标为近似；其他扩展及供应商临时改写无法从会话恢复，会记入局限。工具参数由 Pi 保存的对象重新序列化，无法恢复原始 JSON 空白。图片省略、思考内容丢弃均记录在 transforms 中。

## 13. 代码结构

```
src/
  extension.ts          Pi/OMP 入口：注册命令、绑定宿主 SDK、分发处理
  command.ts            参数解析、帮助、补全（纯函数）
  host.ts               共用 UI、模型目录、会话来源与设置能力
  dsh/
    index.ts            原生命令、设置、已认证交互路由与运行生命周期
    client.tsx          原生命令到工作台的交接、内联交互与设置表单
    workspace.tsx       会话目录、历史时间线、截止点选择与真实资产详情
    styles.ts           宿主主题与响应式工作台布局
    protocol.ts         浏览器/Host 的会话快照、资产与运行状态协议
    ui-bridge.ts        WorkflowUI 到可取消交互状态机的适配
    sessions.ts         原生事件转换、历史截止点恢复和跨会话只读查询
    models.ts           原生模型目录、独立请求流与用量转换
  pi/
    read-session.ts     读取当前分支的历史
    ui.ts               审阅界面、确认框、状态栏
    sources.ts          读取用户选定的其他会话，custom_message 回溯到原会话
    model.ts            解析起草模型和思考等级、外发确认、调用、用量记录
    assist-run.ts       模型辅助的执行流程
    slice.ts            从任意会话的截止点生成草稿（单条回复和长程切片共用）
    issues-ui.ts        "整理长程问题"界面
    config-ui.ts        /casepick config 界面
  core/                 不依赖 Pi，可以单独测试
    messages.ts         宿主无关的消息模型
    convert.ts          转换为 OpenAI messages（第 9 节）
    candidates.ts       候选规则（第 8 节②）
    draft-rule.ts       规则起草
    draft-model.ts      模型起草和结果核对
    issues.ts           主案例、证据时间线、切片去重（长程切片）
    norms.ts            规范表 casepick.norms/1 和默认 rubric 模板
    assist.ts           模型辅助的提示词、回复解析和逐条核对
    reasoning.ts        思考等级的解析和降级
    checks.ts           约束类型及判定（第 7 节）
    digest.ts           RFC 8785 规范化和 task / scoring 摘要（协议 §4）
    rubric.ts           rubric 模板（每种约束一份默认模板、手填空模板）和结构检查
    lint.ts             质量检查（第 8 节④）
    redact.ts           脱敏
  store/
    cases.ts            cases.jsonl 读写、版本、删除
    issues.ts           issues.jsonl 读写
    config.ts           config.json 读写
    marks.ts
  export/
    export.ts           Detroit 内联打包、只导出评分、Inspect 格式
  schema/
    case.ts             TypeBox schema，类型由它推导；和 Detroit schemas/detroit-v2.schema.json 对齐，测试里用后者校验产出
scripts/
  smoke.ts              冒烟脚本，不属于插件（第 14 节）
  build-dsh.mjs         DSH Host ESM 与浏览器 module-table 工厂构建
```

技术选型：TypeScript strict 模式；TypeBox 定义 schema，运行时用 TypeBox 自带的校验（不引入 Ajv 运行时依赖）；测试里用 Ajv 跑 Detroit 的 JSON Schema，核对 CasePick 的产出 Detroit 一定接受；Node 自带的 `node:test` 写单元测试（Node 22.19+ 直接运行 .ts，不引入测试依赖）；起草模型请求用宿主的模型注册表和 `completeSimple`，不自己管理端点和密钥；不引入数据库。

`core/`、`store/` 与案例协议不因宿主增加而分叉。Pi/OMP 的 SDK 只在 `src/extension.ts` 中静态绑定，通过 `WorkflowContext.piSdk` 注入；不要在共用流程里动态导入 SDK，这会绕过 OMP 对 Pi 包名的兼容解析。DSH 提供自己的 `sources`、模型目录和 `pluginSettings`，原生运行路径不需要加载 Pi SDK。

### DSH 适配契约

- **发行与入口**：CasePick `0.1.1` 的基线为 DSH CLI / SDK `0.2.0-rc.2`，原生 peer 精确匹配，不以版本豁免替代迁移。`package.json` 保留 `pi.extensions` / `omp.extensions`，另声明 DSH bundle patch、Host 主入口及 Web Client 入口。浏览器产物是 DSH `__ModuleLoader__` 的模块工厂；React、主题与基础组件由宿主提供。`sidebar.panellist` 和 `main` 使用同一 `casepick` 键注册完整工作台，不新增 HTTP 服务或另一个网站。
- **历史截止点**：`SessionSnapshot.contextAt()` 由宿主实现。Pi/OMP 用 `buildSessionContext(branch, parentId)`；DSH 冻结原生事件快照，在每个历史前缀上重放 `ctx.sessions.messageProjections`，并在所选 assistant 之前的前缀上调用 `foldSurface` 与 `foldRequestHeader`，不能用最新投影倒推旧上下文。session format 4 的工具结果读取原生 `role: "tool"`、顶层 `toolCallId` 与内容块，不再读取旧的嵌套 `tool-result` 块；矛盾的调用关联拒绝转换。存在历史 request header 时，缺省 tools 表示空工具，不套用当前配置。普通 developer 指令合并到 approximate 的 `task.system` 并记录层级、位置损失；纯工具更新只在历史工具集合可由 header 重建时省略，否则拒绝恢复。`deferLoading` 等不可移植声明与供应商私有指令、中间件临时改写均记录局限。
- **只读来源**：DSH 会话定位符为 `dsh:<session-id>`，消息定位符为 `dsh:<seq>`。工作台通过 `sessions/list`、`sessions/read` 取得真实目录、标题、原生角色与快照水位。读取使用 `sessionQuery.observeSession` 获取原生事件及投影，finally 释放 lease；直接截止点操作必须携带页面水位，服务端裁定不可变事件前缀，一次运行冻结来源快照与投影解释器列表，关联来源首次加载后复用。不存在的水位或非助手截止点明确拒绝，不以最新记录悄悄替代。无须启动源 Agent；原生 session-reference 缺少精确 source entry 时仅保留会话及捕获水位用于导航，不构造假截止点。
- **模型调用**：通过原生 LLM 模型目录解析当前或固定模型，用 `prepareCall` 和 `BlockAssembler` 消费流。跟随当前模型时读取原生 `modelSelection` 投影，优先待用选择，其次最近请求，最后宿主默认；不能用恢复会话后可能过期的 `Agent.options` 代替浏览器选择。每次建立独立的 `source.kind: "casepick"` user message，不设置 session ID、tools，也不调用 Agent/subagent。凭据留在 DSH adapter；不复制 API key 或 base URL。原生 reasoning effort ID 只按模型明确声明的能力映射，不把不透明名称猜成 high 等固定等级。失败、取消、缺少终止事件不能当作成功空结果；`length` 即使产生合法 JSON 也不能进入正常提议审阅。
- **交互与取消**：复用 Connection 已鉴权的 `/api/casepick` 精确 Fetch 路由及公开 JSON 信封，不占用网关唯一 interceptor。工作台独立按来源会话维护 run ID、dialog ID、revision 和取消信号，不取得聊天 Agent maintenance；原生 slash command 的接收上下文仍保留 maintenance 互斥。重复启动、过时回答与取消均按身份隔离。命令观察器仅负责将接收会话定位到全局页面；所有选择、编辑、外发确认、Debug、预览与保存由内联面板呈现，完整上下文与较早运行记录可展开查看。会话选择独立于原生聊天选中项，切换页面不能把 A 会话的结果应用于 B。
- **设置与资产**：使用 `.volatile()` 的 `config.get()`，通过与当前 fiber 匹配的 config entry ID 调用 `settings.update`；表单只提交变更字段，共用 `parseSettingsPatch` 整体校验。设置收进 CasePick 子页，配置向导使用工作区明确选择的会话并内联呈现，不再 `layout.selectPanel(null)`。`library` / `library/read` 读取真实 cases/issues，案例校验后按 ID 选择最新 revision，不改写原存储；打开资产页重新读取，避免仍在进行的工作流已保存但列表过时。Debug 原文只在本次运行内存中，不另存文件；不加载 OMP 设置或模拟 OMP 角色。


## 14. 分期

### 阶段 0：先手工做出样板

先不写插件。从自己的 Pi 会话里挑 10–20 个真实的犯错场景，手工写成第 7 节格式的案例（每条要求都写 rubric），同时写好 `schema/`、`core/digest.ts`、`core/checks.ts`、`core/rubric.ts`、`core/lint.ts`。样板直接用 `detroit.case/v2` 格式，并且要能通过 Detroit 的 JSON Schema 校验。

再写 `scripts/smoke.ts`，它不属于产品功能，只用来确认数据确实能用：

1. 读取 JSONL，把每条 `task.messages` 和 `task.tools` 发给一个 OpenAI 兼容模型，打印模型输出和 `scoring.requirements`，并列放在一起。
2. 用脚本里自带的评审提示词（按 `detroit.judge/v1` 的请求和响应格式），让评审模型按 rubric 判一次**原出错输出**，同一条重复判 3 次。期望结果是每次都判"违反"。判成"通过"或前后不一致，说明 rubric 写得不够清楚。

**完成标准：**
- 所有样板通过 lint。
- 冒烟脚本能把全部样板发出去，并拿到正常响应。
- 评审模型对所有样板的原出错输出都稳定判为"违反"；不满足的样板据此修改，并把修改原因总结进第 7 节的 rubric 写法规则。
- 统计样板中每种约束类型实际用到几次、有多少要求只能靠 rubric，据此确定首批约束类型。
- 回头看一遍样板，确认 schema 里没有多余字段，也不缺字段。

这一步的目的是在写生成逻辑之前，先把"好数据长什么样"定死，尤其是 rubric 的写法。

### 阶段 1：Pi 上不用模型也能走通

读取当前分支、候选规则、手填和规则起草（含 rubric 模板）、lint、审阅确认、本地存储、导出 Detroit 评测集，同时收敛命令。

**完成标准：**
- 在真实 Pi 会话里，从扫描到导出完整走通。
- 导出文件通过 lint 和冒烟脚本。
- 第 15 节场景 1–5、8–12 通过。
- 扫描一个 500 条消息的会话时，Pi 界面不卡顿。

### 阶段 2：模型起草

起草模型配置（`/casepick config`，默认跟随当前模型、思考等级 low）、脱敏、外发确认、结构化输出（含 rubric）、核对、用量记录、取消。

**完成标准：**
- 第 15 节场景 6、7、13 通过。
- 用 20 个真实候选测试，记录模型草稿不经修改直接确认的比例、rubric 不经修改直接确认的比例，作为后续改进的基线。
- 这 20 条用冒烟脚本跑 rubric 自检，记录评审模型稳定判"违反"的比例。

### 阶段 3：长程任务切片

主案例、证据时间线、跨会话读取、三种期望依据、规范表和新增 lint，先人工版再加模型辅助。详见 [长程任务的案例切片](long-trajectory-slicing.md) 第 12 节。

### 阶段 4：补全

书签、`--format inspect`。

## 15. 必须通过的场景

1. 用户先说"只输出 JSON"，模型违反，随后用户纠正：生成评审方式为 `program` 的案例；`task.messages` 里有原要求，没有出错回答和纠正。
2. 用户在模型回答**之后**才第一次提出"只输出 JSON"：lint 拦下，提示"要求出现在截止点之后"。
3. 原要求所在的消息已被压缩：`task.messages` 里是压缩摘要；如果摘要里找不到原要求，就无法引用，案例不能确认。
4. 会话有分支：扫描结果不包含已放弃分支上的消息。
5. 截止点前有多个并行工具调用：转换后调用和结果一一配对，顺序与原文一致。
6. 起草模型返回不存在的消息编号或伪造的引文：对应字段被清空并标为需要人工补，不会自动重试。
7. 外发前预览的内容和实际发送的请求一致；取消后不再发送剩余请求。
8. 约束对原出错输出判定为"通过"：该约束标红，评审方式降为 `rubric` 或要求修改。
9. 删除案例后重新导出：被删的案例不出现在文件中；另一个 Pi 窗口同时追加的案例不会丢失。
10. 导出文件拿到另一台机器上，不依赖 Pi 和原会话，也能通过 Detroit 的 JSON Schema 校验和导入检查（协议 §10），并核对所有引文和 `observed` 例子。
11. 要求无法写成约束（比如"改代码前先问我"）：手填 rubric 后可以确认，评审方式为 `rubric`；rubric 缺 `fail` 例子时不能确认。
12. rubric 里大段照抄了用户的纠正语：lint 给出警告，用户确认后才能继续。
13. 起草模型给出的 `observed` 例子在原出错输出里找不到：该例子被清空，rubric 因缺少 `fail` 例子而标为需要人工补。
14. 已确认的案例只改了 rubric：新版本的 `digests.task` 不变、`digests.scoring` 改变；只导出评分时得到的 `detroit.scoring/v2` 的 `target.task_digest` 等于原题摘要。

## 16. 指标

只统计生产过程本身，不统计任何评测结果：

- 每条案例从打开候选到确认花了多少时间，其中编辑 rubric 花了多少时间。
- 候选的去向比例：确认、丢弃、跳过。
- 模型草稿不经修改直接确认的比例；rubric 单独统计。
- 案例中 `program` 和 `rubric` 两种评审方式的比例。
- lint 拦截和警告原因的分布（用来发现规则和起草提示词的问题）。
- 起草模型的调用次数、耗时和 token 用量。

## 17. 风险和待验证

| 风险 | 怎么验证 | 验证失败怎么办 |
| --- | --- | --- |
| Pi 扩展 API 拿不到完整的分支历史 | 阶段 1 第一件事：在 Pi 1.1.0 上实测 | 改为读会话 JSONL 文件，按 Pi 文档中的会话格式解析，并锁定支持的版本 |
| 压缩后会话文件里是否还保留原始条目，以及压缩摘要以什么形式进入上下文 | 构造一个触发压缩的会话，对照会话文件 | 按实际行为处理；不确定的部分写进 `limitations` |
| 会话里没有系统提示和当时的工具定义 | 检查会话格式 | 标记为 `missing` 或 `approximate`，案例照样可用 |
| Detroit 协议还是草案，字段可能变化 | 跟踪 Detroit `docs/10-dataset-format.md` 的审阅结果 | 格式相关代码集中在 `schema/`、`core/digest.ts`、`export/`；测试直接用 Detroit 的 JSON Schema 校验，协议变了测试会先失败 |
| 候选规则漏报多 | 用阶段 0 的样板反查：规则能否找到这些位置 | 补充规则；书签兜底 |
| 模型起草的引文不可靠 | 阶段 2 的 20 条基线 | 改提示词；引文核对本身保证错误的引文进不了案例 |
| rubric 写得含糊，评审模型判不稳 | 阶段 0、2 用冒烟脚本对原出错输出重复评审 | 收紧第 7 节的写法规则，改起草提示词和默认模板；必要时增加 rubric 字段 |
| rubric 偷偷用了截止点之后的信息（比如照抄纠正语） | 阶段 0 人工复查样板；lint 警告的命中情况 | 调整警告阈值；在起草提示词里更明确地禁止 |
| 用户嫌写 rubric 麻烦，审阅变慢 | 阶段 1、2 统计编辑 rubric 的耗时 | 加强默认模板和模型起草；审阅界面只突出需要人工补的字段 |
| 截止点前历史很长，`task.messages` 过大 | 统计阶段 0 样板的大小 | 提供截断工具输出的选项，并记录截断 |

## 18. 待确认的决策

已确认（2026-10-13）：起草模型从宿主已配置的模型里选，默认跟随当前会话的模型、思考等级 low，可以在 `/casepick config` 里改；长程任务按 [长程任务的案例切片](long-trajectory-slicing.md) 处理。

已确认（2026-10-12）：案例格式直接采用 Detroit 定义的 `detroit.case/v2`；评分可以和题目分开分发（Detroit 09 D10、D11）；导出时 `purpose` 默认 `improvement`，因为日常犯错攒下的案例很可能会被拿去调提示词，错把改进数据当验证数据会高估泛化能力。

以下几点本文按左列的方案写，如果不同意需要调整：

| 决策 | 本文方案 | 另一种选择 |
| --- | --- | --- |
| 书签 `/casepick mark` | 做，只存 entry ID，不读内容 | 不做，完全依赖事后扫描 |
| 起草模型外发确认 | 每个端点首次完整预览；之后每批一行确认，可展开全文 | 每批都必须看完整请求内容再确认 |
| 插件内的 rubric 自检 | 不做。rubric 只做确定性检查；用评审模型验证 rubric 只在 `scripts/smoke.ts` 里做，不属于插件 | 在审阅界面提供手动触发的"rubric 自检"：用户确认后，调用起草模型按 rubric 判一次原出错输出，期望结果是"违反"。能提前发现含糊的 rubric，但要多花一次模型调用，而且已经接近评测 |

## 19. 与上一版相比的变化

**2026-10-13：**

- **起草模型改为从宿主的模型注册表里选**，默认跟随当前会话的模型、思考等级 low，凭据由宿主提供；去掉原来的 `base_url`、`api_key_env` 独立端点配置。`/casepick config` 提供模型和思考等级的选择界面。
- **新增长程任务切片**（[长程任务的案例切片](long-trajectory-slicing.md)）：主案例和证据时间线、三种期望依据、规范表、防后见之明检查。对外格式不变，新增信息放在 `x-casepick`。
- 代码结构新增 `core/issues.ts`、`core/norms.ts`、`pi/sources.ts`、`pi/model.ts`、`pi/config-ui.ts`、`store/issues.ts`、`store/config.ts`；分期新增阶段 3（长程任务切片），原阶段 3 改为阶段 4。

**2026-10-12 第二版：**

- **案例格式改为 Detroit 评测集格式 `detroit.case/v2`**，不再定义 `casepick.case/v1`。字段映射见第 7 节；`input` → `task`，`expected` → `scoring`，`observed` → `diagnostic`。
- **去掉 `quality` / `judge_mode` 和单一 `hash`**，改为 `digests.task` 和 `digests.scoring` 两个摘要。
- **评审协议和评审提示词交给 Detroit**，导出不再附带 `casepick-judge-v1.md`；`export/judge-prompt.ts` 删除。
- **导出改为 Detroit 内联打包**（`cases.jsonl` + `dataset.json`），新增"只导出评分"；导出前用 Detroit JSON Schema 校验。
- 新增 `core/digest.ts`、场景 14 和协议变化风险；确认导出时 `purpose` 默认 `improvement`。

**2026-10-12 第一版：**

- **新增评审标准（rubric）**，作为案例质量的主要载体：每条要求必须有 rubric，包括判定问题、通过和违反的标准、边界情况、例子，并且至少一个 `fail` 例子取自原出错输出。
- **新增评审协议和参考评审提示词模板**（`casepick.judge/v1`），随导出交付，插件本身不运行评审。
- **A/B 质量分级改为评审方式 `program` / `rubric`**，两者没有优劣之分，`rubric` 是常态。
- **约束类型收缩**：先做 `json_only`、`contains` / `not_contains`、`regex` / `not_regex`、`tool_called` / `tool_not_called`；`json_schema`、`language` 等阶段 0 数据证明需要时再加。每种约束配一份默认 rubric 模板。
- lint 新增 rubric 相关检查；阶段 0 冒烟脚本新增按 rubric 评审原出错输出；新增场景 11–13 和相关风险、指标。

**2026-10-11：**

- **定位不变**：只生产数据，不做评测。
- **新增**"什么是一条好案例"的明确标准和对应的 lint；新增约束自洽检查和 A/B 质量分级。
- **`input` 改为直接使用 OpenAI messages 格式**，另提供 Inspect AI 格式导出；新增阶段 0（手工样板加冒烟脚本）。
- **命令从 7 个收敛到 5 个**；扫描、起草、审阅合并为一个入口。
- **存储从多目录不可变文件加文件锁，简化为几个 JSONL 文件**；证据直接内联在案例里，不再共享存储。
- **模型起草作为质量的主要来源**；规则主要负责发现候选和定位截止点。
- **OMP 从同期交付改为阶段 3。**
- **外发确认从"每批看全文"调整为"每个端点首次看全文，之后每批一行确认"**（待确认）。
