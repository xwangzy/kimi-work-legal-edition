# 验收流水线（真实界面回归）

在产品真实界面上、调用真实模型，把一批卡片从发起跑到交付，取回成果、评分、出矩阵。第 42 批（2026-11-12）入库：此前这些脚本只在各次会话的临时目录里，V13 → V14 → V16 每轮手工复制一遍。

## 通过口径（只有一个）

`grading/质量评估标准.md` 第三节的“可交付”：**未命中一票否决项，总分 ≥ 20，8 个维度都 ≥ 2**，且成果文件全部能打开。
`matrix.mjs` 按这个口径从各维度分数重新判定，不采信评分人自己写的“已通过 / 未通过”；两者不一致的逐条列出。
（V16 及以前口头上有“21 分”“≥ 20 分”两种说法，以这里为准。）

所有分数都是 **AI 预验收**，不是执业律师的验收。

## 目录

| 路径 | 内容 |
|---|---|
| `cards/cards16.json` | 卡片集（60 张）：标签、卡片、事项、材料、开始面板字段、补充要求、预设回答 |
| `materials/` | 测试材料（虚构案例；起栈时同步到 `apps/desktop/kwl-testdocs/`，由界面开发服务器提供） |
| `answers/` | 答案要点与运行卡（评分依据）；`V16/律师答题记录-第二轮.md` 是第二轮对产品提问的实际回答，再跑同一张卡时照它答 |
| `grading/` | 《质量评估标准》与《评分工作说明》（交给评分人的说明） |
| `driver.js` | 注入界面的驱动脚本：新建事项、拖入材料、填开始面板、点开始 |

## 一轮回归怎么跑

运行期文件都在工作目录（环境变量 `KWL_EVAL_DIR`，缺省系统临时目录下的 `kwl-eval`），不进仓库。

```bash
export KWL_EVAL_DIR=/path/to/workdir
# 1. 写测试栈清单（端口自定；model 是这套栈的上游型号，缺省 kimi-k3.1-pro）
echo '[{"name":"a","web":5431,"bridge":8011,"gw":18011,"search":18012}]' > $KWL_EVAL_DIR/stacks.json
# 2. 起栈（密钥只从钥匙串读，只给网关进程）
node eval/up.mjs a
# 3. 发起（全新发起；不要拿“重新运行”的成果评质量）
node eval/launch.mjs a m12-enforcement m27-policy-review
# 4. 常驻自动确认计划与论点提纲；提问由人按预设回答处理
node eval/autoapprove.mjs &
node eval/status.mjs --wait          # 有提问超过 60 秒没人答、或全部到终态时返回
node eval/question.mjs a <run> <mat> # 读提问
node eval/answer.mjs a <run> <mat> '[{"pick":"选项片段"},{"other":"自己写的话"}]'
# 5. 取成果（含 LibreOffice 实际打开）
node eval/grab.mjs $KWL_EVAL_DIR/out
# 6. 评分：把 grading/评分工作说明.md 连同 E / OUT / GRADES 三个路径交给评分人，每人 4～6 个标签，并发不超过 4～5 路
# 7. 汇总
node eval/matrix.mjs $KWL_EVAL_DIR/grades --prev <上一轮评分目录>
node eval/ledger-summary.mjs         # 耗时、用量、成本、工具调用与工具结果
node eval/up.mjs --stop a
```

铺开前先评 5～10 张，确认没有系统性缺陷再跑全量。

## 不调模型的三个检查

| 命令 | 用途 |
|---|---|
| `node eval/replay-deliverable-check.mjs <成果目录> --list` | 用当前代码对已取回的成果重做“质量说明清理”与“交付前检查”：改规则前后各跑一遍，看会多拦什么、有没有误删 |
| `node eval/ledger-summary.mjs <ledger.db>…` | 任意旧账本的耗时、用量、成本；“只更新工作清单的往返”占比；第 42 批起还有各工具的结果分布（锚点找不到几次、交付前检查报了哪几类） |
| `node eval/agreement.mjs <评分目录甲> <评分目录乙>` | 同一批成果两次评分的一致性 |

## 评分一致性

同一份成果让评分人再评一次，分数会不一样。两轮回归的分数差要先和这个波动比，才知道是不是真的变了。
做法：从上一轮成果里抽 10 张左右，用同一份工作说明再评一遍，`agreement.mjs` 比较。结果记在当轮的验收记录里。

## 已知限制

- 评分人是 AI，答案要点是出题时写的；漏分析类扣分依赖答案要点的完整程度。
- 账本里的成本按网关对路由型号的定价算；换了上游型号（如高速档）时成本数字不反映实际价格，看 token 数。
- 提问要人按预设回答作答；预设之外的问题，作答人自己判断并记进 `answers.log`。
- `probe-models.py`、`stack.mjs` 读钥匙串的部分只适用于 macOS。
