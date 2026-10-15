# CasePick

把 Pi / Oh-My-Pi（OMP）/ DeepSeek Harness（DSH）会话中的一次犯错整理为 Detroit v2 评测案例。

支持本地规则起草、手动审阅保存、跨会话主案例，以及模型辅助找证据、提议切片和起草要求。规则与手工流程不需要配置模型接口。

## 使用

开发与测试需要 Node.js 22.19+。先在项目目录安装依赖：

```sh
pnpm install
```

在已安装的 OMP 中启动：

```sh
pnpm dev:omp
```

也可直接运行 `omp --extension ./src/extension.ts`；从其他目录启动时，将扩展路径改成绝对路径。入口同时声明在 `package.json` 的 `omp.extensions` 和 `pi.extensions` 中，不会自动修改全局 OMP 配置。OMP 兼容性验证覆盖 18.8.6 和 18.10.3。

原有 Pi 1.1.0+ 用法保留：

```sh
pnpm dev:pi
```

### DSH（Web 界面）

在项目目录构建后安装到 DSH 的 Web profile：

```sh
pnpm build:dsh
# 新建 profile 时执行一次；已有 Web profile 可跳过并替换下面的 profile 名。
dsh --profile casepick --from-default-profile web --dump-config
dsh plugin --profile casepick add "link:$PWD"
dsh --profile casepick
```

在 DSH 中打开需要整理的会话，使用 `/casepick` 或 `/casepick config`。原生浏览器弹窗提供与 Pi/OMP 相同的审阅、编辑、确认保存和长程问题流程。会话列表来自 DSH `sessionQuery`；手动定位其他会话时使用原生 session ID 或 `dsh:<session-id>`，不输入 Pi JSONL 路径。

验证基线：DSH CLI `0.1.5-rc.1`、SDK `0.1.5-rc.2`。当前 DSH 前端入口面向 Web，不提供 ACP/headless 交互界面。`pnpm pack` 会自动构建原生入口；Pi/OMP 仍使用原来的 `src/extension.ts`，无须构建 DSH。

### 整理与保存

Pi/OMP 用 `/resume` 打开需要整理的会话；DSH 从侧栏打开会话。等回复结束后执行：

```text
/casepick
```

1. 选择“审阅疑似犯错”，或“手动选择历史回复”。
2. 查看预填的要求、原文出处、评审标准和原出错输出。明确的“只输出 JSON”“不要代码块”要求可以自动起草；其他要求使用“添加要求”手动填写。
3. 按需编辑标题、要求、程序约束、评审标准及环境依赖。引用必须来自出错之前的输入，违反例子必须摘自原出错输出。
4. 处理检查错误，核对提示后选择“确认保存”。保存前会展示文件路径和大小。

每条已确认案例追加为一行 `detroit.case/v2` JSON，默认保存到：

```text
~/.local/share/casepick/cases.jsonl
```

设置了绝对路径的 `XDG_DATA_HOME` 时，保存到该目录下的 `casepick/cases.jsonl`。保存文件可以直接查看；评测集打包导出尚未实现。

返回候选列表会保留本次扫描内的草稿；退出 `/casepick` 后，未确认的草稿不会保存。取消任一步骤不会向当前会话发送消息。

## 模型辅助调试

Debug 默认关闭。OMP 中将 CasePick 装成插件后，在 **Settings → Plugins → casepick → debug** 切换开关；也可以在 `/casepick config` 中选择 **Debug 模式**。Plugins 中显式设置的值优先，包括 `false`；被覆盖时，`/casepick config` 会提示到 Plugins 修改。配置变更在下一次模型辅助调用时生效。

DSH 中在 **Settings → Plugins → Plugin configuration → CasePick** 切换 **Debug mode**；该开关由 DSH 原生设置持久化，优先于 CasePick 本地配置。起草模型等普通配置仍可从 `/casepick config` 修改。DSH 不读取 OMP 的 Plugins 设置，也不会因缺少 OMP API 而出现设置读取警告。

开启后，“用模型找证据”“用模型提议切片”和“用模型起草要求”会在每个请求结束后打开 Debug 菜单，可查看：

- 实际发送的脱敏后请求及脱敏命中。
- 完整原始回复、JSON 解析结果、核对通过数量和每条拒绝原因。
- 模型、实际思考等级、输出上限、超时、停止原因和 token 用量。

空候选会明确标为“模型返回空候选列表”；解析失败或调用失败也能查看诊断。空列表不代表会话没有问题，当前模型回复协议不要求提供空结果原因。选择“继续”处理下一段请求或进入正常审阅。

诊断只在本次调用的界面中展示，不写入案例或日志，不收集调用凭据。原始回复可能包含敏感内容；`usage.jsonl` 仍只保存模型与用量。关闭 Debug 后不会弹出调试菜单，也不会增加模型调用。

## 当前范围

- 只读当前会话分支，按所选出错位置重建压缩后的上下文；不会使用后续纠正作为输入。
- Pi/OMP 使用当前宿主的 `buildSessionContext` 重建出错回复父节点的上下文，保留 Pi 的上下文编辑和 OMP 的压缩、reset 语义。DSH 按截止点之前的原生日志前缀，用 `foldSurface` 和 `foldRequestHeader` 恢复历史消息、系统提示与工具定义。
- OMP 记录的基础系统提示及 `developer` 指令合并到 `task.system`，标记为 `approximate` 并说明层级、时序及临时覆盖的局限；不会把它们降级为用户要求。没有录制系统提示时仍标记缺失。
- 规则起草不调用模型、不外发内容；模型辅助调用前会展示脱敏后的请求并要求外发确认，不授予模型工具执行权限。
- DSH 模型辅助直接调用原生 `llm.prepareCall().stream()`，由 DSH 适配器处理认证；不使用 curl 或子 Agent，不修改当前会话模型，也不向对话插入辅助请求。DSH 自身仍会记录 slash command 的 `command/run`、`command/done` 事件。
- DSH 引用其他会话的元数据只有会话 ID 与捕获水位时，只用于导航，不伪造原始回复 ID。图片、附件等无法恢复为可移植文本的内容会明确记录省略。
- 保存本地原文，尚未自动脱敏。图片会替换为省略标记，思考内容会丢弃；这些变化和其他无法恢复的信息会写入案例说明。
- 单次上限为 2000 条消息或 20 MB，超限会停止，不会悄悄截断输入。
- 模型辅助仍沿用现有的分段、脱敏和逐字核对流程；本次适配没有改变长会话的内容准备策略。完整案例读取上限与模型请求的分段预算是两回事。
- `/casepick help`、命令补全和 `/casepick config` 可用。书签、已有案例管理和打包导出仍未实现。

数据结构、检查规则和后续范围见 [技术设计](docs/casepick-technical-design.md)。

## 开发验证

```sh
pnpm typecheck
pnpm test
pnpm build:dsh
```

类型检查分别覆盖 Host 与浏览器入口。测试覆盖 Pi 历史上下文、真实 OMP 宿主加载与指令时序，以及 DSH 截止点重建、工具结果、原生模型调用和交互取消。DSH 实机验收还应在隔离 profile 的浏览器中完成模型外发确认、Debug、跨会话读取与案例保存；无需使用真实付费模型即可验证原生适配器链路。
