# Detroit 固件

从 Detroit 仓库复制，用来核对 CasePick 的产出能被 Detroit 接受。不要手改。

| 文件 | 来源 |
| --- | --- |
| `detroit-v2.schema.json` | `schemas/detroit-v2.schema.json` |
| `cases.jsonl`、`scorings.jsonl`、`dataset.json` | `examples/datasets/v2/casepick-inline/` |

来源提交：Detroit `8ad23b6`（分支 `docs/case-protocol-v2`）。

Detroit 的协议更新后，重新复制这些文件并更新上面的提交号，再跑 `pnpm test`。
