# C 组：技术债、历史设计与架构合理性审查（V17 基线 v17-b42）

审查对象：`/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/v17-b42`（497 提交）。只读审查，未改代码。
标注：【已核实】= 亲自读到代码或跑了命令；【推断】= 依据间接证据的判断。

---

## 0. 基础事实（后文引用）

### 0.1 提交构成【已核实】
`git log --format=%s | awk '{split($1,a,":");print a[1]}' | sort | uniq -c`：
fix 277、feat 121、docs 65、test 13、merge 5、chore 4、fix(ui) 2、ci 2、**refactor 1**。
→ 497 个提交里 56% 是 fix，refactor 只有 1 个。项目一直在"加功能 + 修复审查意见"，从未做过集中整理。这本身就是 V18 "最小有效整理"的合理性依据。

### 0.2 kap-host 的 31.8 万行构成【已核实】
`platform/packages/kap-host/vendor/kap-embed/kap-embed.mjs` 单文件 **308,225 行**——这是 Kimi Code（上游 MoonshotAI/kimi-code 2.2.0 tag + `third_party/patches/kimi-code-2.2.0-zhongruan.patch`）打包后的产物，由 `scripts/build-kap-embed.mjs` 生成（package.json `build:vendor`）。
自写部分只有 `src/`（runtime.ts 1038、search/engine.ts 799、policy.ts 490、sealed-storage.ts 488 等，合计约 1 万行）。
→ 结论：kap-host 实际自有代码约 1 万行，不是 31.8 万行的维护负担；31 万行是第三方构建产物，应在规模统计里剔除。漂移由 `.github/workflows/engine-drift.yml` 重建 fork 后跑 `embed-drift.test.ts` 把关——这个机制是成熟且必要的，**保留**。

### 0.3 包引用矩阵（grep `@zr-legal/<包名>` 或 `/<包名>/src`）【已核实】
命令：对 packages/*/src、services/*/src、apps/*/src|electron|dev、scripts 做 grep，排除包自身目录。

| 包 | 自有行数 | 桌面端+内核 src 引用文件数 | 任何 src 引用 | 其他包测试引用 | 实际引用方（摘） |
|---|---|---|---|---|---|
| kap-host | ~1万（另 30.8 万 vendor） | 3 | 3 | 1 | kernel/executor/kap-agent-client.ts、electron/main.cjs |
| kernel | 72,733 | — | — | 11 | electron/main.cjs |
| docx-engine | 6,847 | 21 | 23 | 55 | 内核工具 |
| egress-gate | 6,741 | 15 | 15 | 8 | 内核 egress/* |
| egress | 440 | 15 | 17 | 7 | 内核 egress/*、ledger-signer |
| exec-wasm | 5,235 | 0 | 1 | 2 | **仅 kap-host/src/w-domain.ts** + scripts/build-runtime.mjs |
| tokenizer | 4,630 | 15 | 22 | 18 | 内核 |
| keys | 1,906 | 21 | 38 | 46 | 内核、多服务 |
| firm-trust | 1,600 | 5 | 16 | 19 | 内核 control-plane/*、onboarding；云端 6 个服务 |
| file-broker | 1,574 | 0 | 10 | 9 | kap-host、exec-wasm（间接在真实路径） |
| parse-ocr | 1,111 | 2 | 2 | 6 | 内核 |
| model-broker | 1,070 | 5 | 5 | 2 | 内核 executor/kernel-gate |
| ops-auth | 997 | 0 | 4 | 7 | 只云端服务 + ops 脚本 |
| lawdb | 859 | 13 | 14 | 13 | 内核 |
| safe-log | 807 | 15 | 21 | 0 | 内核 |
| domain | 682 | 53 | 71 | 23 | 全局类型 |
| blob-store | 662 | 0 | 2 | 1 | 只 cp-signer/archive、support-api、cloud-serve.mjs |
| at-rest | 573 | 3 | 15 | 9 | kap-host、exec-wasm、file-broker |
| im-connectors | 563 | 0 | 1 | 2 | **仅 apps/firm-node/src/im-runtime.ts** |
| content-dist | 405 | 1 | 2 | 1 | 内核 content-updates、egress-gate/dist-relay |
| host-policy | 307 | 4 | 8 | 4 | kap-host、内核 registry |
| sync | 243 | 2 | 2 | 14 | 内核 sync-engine.ts、share-relay.ts |
| design-tokens | 149 | 2 | 2 | 2 | 界面 |
| seat-token | 135 | 2 | 11 | 19 | 内核 governance + 全部云服务 |
| pseudonym | 110 | 3 | 4 | 0 | 内核 redact/docx/executor、egress |
| service-auth | 90 | 4 | 4 | 0 | 内核 identity/registry/local-server |
| control-plane | 7,491 | 0 | 1 | 4 | 云端服务 |
| legal-gateway | 1,987 | 0 | 1 | 4 | 云端服务 |
| cp-signer | 1,284 | 0 | **0** | **0** | 无任何其他代码引用（独立进程） |
| relay-api | 1,343 | 0 | **0** | 3 | 无 src 引用 |
| notify-api | 843 | 0 | **0** | 2 | 无 src 引用 |
| support-api | 664 | 0 | **0** | 1 | 无 src 引用 |
| search-service | 344 | 0 | **0** | 3 | 无 src 引用 |
| dist-api | 192 | 0 | 0 | 1 | 无 src 引用 |
| firm-node | 510 | 0 | 0 | 4 | 无 src 引用 |

注意：云服务本来就是独立进程，"无 src 引用"不等于没用——要看它是否被部署脚本拉起、桌面端是否配置了它的地址。见第 3 节逐项判断。

### 0.4 fix 提交热点（按文件统计 fix 提交次数，前 30）【已核实】
命令：`git log --format='@@%s' --name-only | awk '/^@@/{fix=($0~/^@@fix/)} NF&&fix{print}' | sort | uniq -c | sort -rn`

| 次数 | 文件 | 行数 |
|---|---|---|
| 46 | packages/kernel/src/api/index.ts | 5,207 |
| 41 | packages/kernel/src/executor/executor.ts | 2,288 |
| 33 | docs/privacy/residency.json | — |
| 25 | docs/v9-开发计划与进度.md | — |
| 24 | apps/desktop/src/lib/scenarios.ts | 1,434 |
| 23 | apps/desktop/src/api.ts | 1,438 |
| 20 | packages/tokenizer/src/names.ts | 811 |
| 19 | packages/kernel/src/services/independent-review.ts | 684 |
| 19 | packages/kernel/src/index.ts | 1,264 |
| 18 | packages/kernel/src/tools/tools/revise.ts | — |
| 16 | content/skills/doc-revise/SKILL.md | — |
| 16 | apps/desktop/src/styles.css | — |
| 15 | packages/kernel/src/tools/registry.ts | — |
| 14 | packages/kernel/src/tools/tools/review.ts | — |
| 14 | packages/kernel/src/sync-engine.ts | 1,357 |
| 14 | packages/kernel/src/services/deliverable-check.ts | 685 |
| 13 | packages/kernel/test/b38-independent-review.test.ts | — |
| 13 | services/review-cards.ts、executor/casefile.ts、docx-engine/src/revise.ts | — |
| 12 | services/share-relay.ts、skills/contract-review、skills/AGENTS.md | — |


---

## 1. 受模型能力限制形成的临时方案（问题 1）

### 1.1 工作时限层层加码：单任务最坏 105 分钟、四个独立常量【已核实】
- 现象：`packages/kernel/src/executor/executor.ts` 里有四个各自为政的时限常量：
  - `:2153 export const AGENT_WORK_LIMIT_MS = 40 * 60_000;`（主轮）
  - `:966 export const REDLINE_LIMIT_MS = 25 * 60_000;`（D-178 修订稿段）
  - `:1449 const REVIEW_LIMIT_MS = 15 * 60_000;`（独立复核）
  - `:1452 const REVIEW_FIX_LIMIT_MS = 25 * 60_000;`（复核后修改轮，D-163）
  另有 `AGENT_WALL_MS = 8h`（:2144）。审合同+修订稿最坏 40+25+15+25 = 105 分钟。
- 证据（引入链）：D-152（10→25 分钟，"审一份 11 条采购合同约 9.5 分钟…劳动仲裁申请书…用满 10 分钟"，第 27 批）→ D-159（25→40，提交 `b38cbec`，11-03 拍板）→ D-163（修改轮 15→25，"47 张卡里 5 个部分完成全部撞这一时限"）→ D-178（审合同拆两段，"审查本身近 40 分钟，复核与修改轮都没跑"）。进度文档第 42 批：高速档 `kimi-k3.1-pro-highspeed` "工作时间中位 12.2 分钟（第二轮 25.8），10/10 通过…无任务撞时限"；标准档"2 单撞 40 分钟时限"。
- 根因：时限是对"模型慢 + 整份重写（D-169/D-170 记录同一份 97 行表整份重出 4 次、1.3 万字修改三次全量重发）"的补偿。D-169（xlsx.edit_cells）、D-170（revise amend 补交）已经把"整份重写"这一真正的耗时根因修了；高速档又把中位时间减半。
- 现在是否成立：40 分钟主时限在标准档仍需要（第 42 批"标准档在 40 分钟时限上没有余量"）；但"每段一个常量、分别调"已无必要。
- 建议：**精修**——把四个常量收成一张"阶段时限表"（主轮 / 修订稿段 / 复核 / 修改轮）+ 一个任务总预算，按档位（标准 / 高速）取值；D-152 原提的"按方法分档"一并落在这张表里。不改默认值，只改组织方式。
- 预期收益：拍板 D-163/D-152 时只改一处；避免下一次再加第五个常量。
- 范围/成本/风险：executor.ts 4 处 + 环境变量读取；约 0.5 人日；风险低（行为不变）。
- 验证：`b41-redline-stage`、`b38-independent-review`、超时类用例全过；grep `_LIMIT_MS = ` 在 executor.ts 只剩一处表定义。

### 1.2 D-178 审合同拆两段：模型慢的产物，在高速档 + amend 之后应重新评估【已核实事实 / 推断结论】
- 现象：`wantsRedlineStage()`（executor.ts:958）只对 `contract-review` 生效（`REDLINE_STAGE_SKILLS = new Set(["contract-review"])`, :961）；`runRedlineStage()`（:1331）是第三份几乎相同的轮询循环（见 2.1）。
- 证据：D-178 理由"第三轮真实复验 D2：审查本身近 40 分钟，复核与修改轮都没跑；用户 11-11 拍板'拆成两段'"；真实界面"19 未通过 → 修三处后 21 通过，已完成 62 分钟"。
- 根因：一个会话一个时限，审查吃光时限后修订稿与复核都跑不到。是"时限模型"问题，不是"业务需要两段"。
- 现在是否成立：拆两段本身对律师是合理的（先看意见再出修订稿），**保留语义**；但它不应是一份专门写给 contract-review 的特例代码。【推断】高速档下单段可能已能完成，但用户已拍板两段，不建议回退。
- 建议：**合并**——与 1.1、2.1 一起收进"阶段运行器"：主轮 → [修订稿段] → [复核] → [修改轮]，每段 = (提示, 时限, 事件序号段, 是否出计划)。修订稿段不再是独立函数。
- 收益/成本/验证见 2.1。

### 1.3 独立复核（D-161）：机制有效，但实现方式有遗留缺口【已核实】
- 现象：交付 Word 后内核另起一次无上下文复核调用（推理强度缺省 low），意见交回原会话修改。`services/independent-review.ts` 684 行、**19 个 fix 提交**（全部集中在第 39～41 批），测试 `b38-independent-review.test.ts` 13 次 fix。
- 证据：D-161 理由"18 份独立评分 13～18 分…同一上下文自查找不出自己的盲点；V13 实验…复核找到评分律师点名的实质缺陷"。第 42 批记录"本轮看到、未修：独立复核遇上游拒绝即跳过而任务仍记成功（3 张卡）"。fix 主题（git log）：复核覆盖范围（表格、庭审提纲、回稿重审）、复核意见序号识别（"【1】""1.""（1）"）、法条原文附上、修改轮接错会话（D-171）、只替换已知姓名（D-172/D-177）。
- 根因：复核意见是自由文本，内核再用正则去"认序号"（b8b428c："复核意见没按'【1】'写序号时也能认出"）——这是早期不敢依赖模型结构化输出的典型做法。
- 现在是否成立：复核的业务价值成立（评分证据），**保留**。用正则解析自由文本意见不再必要——K3.1 已在用工具调用（`rules.propose`、`docx.revise` 都是结构化入参）。
- 建议：**精修**两点：(a) 复核意见改为结构化输出（JSON 或一个 `review.submit` 工具：必改 / 建议 / 存疑 + 定位），去掉序号正则；(b) 上游拒绝时把任务记为"部分完成·复核未做"而不是成功（第 42 批已发现未修）。
- 收益：去掉一类反复修的正则；结果状态如实。
- 成本/风险：约 2～3 人日；需改复核提示词（另组负责）；风险中——要回归 b38/b41 复核用例和一轮真实复核。
- 验证：注入上游 4xx/拒绝时任务终态非 succeeded；复核意见解析失败率在 eval 账本里为 0。

### 1.4 各类内核兜底清理（质量说明行删除、本机路径替换、交付前检查）【已核实】
- 现象：`scrubQualityLine`（第 42 批）、`replyWithoutLocalPaths`（executor.ts:1672）、`deliverable-check.ts`（685 行，14 次 fix）、D-174/D-176 对【待确认】、"事实 N"的处理。
- 证据：第 42 批记录"回放第二轮 154 份最终成果：清理 29 份文件 25 张卡 46 处…真实任务 20 单最终成果 0 处（本轮内核清理未触发，更可能是…工作准则第 10 条的效果，清理是兜底）"；"检查报出的问题模型基本都改了（154 份里只剩 9 份）"。
- 根因：提示词约束不稳时，在内核后处理兜底——合理的纵深防御。
- 现在是否成立：成立。这类兜底成本低（纯函数、有回放数据），且命中率已趋零，正是"兜底"应有的样子。
- 建议：**保留**（不要因"0 次触发"删除；对外文书里漏一条"未经本所质量验收"的代价远高于这几十行）。只需把散落在 executor.ts 的 `replyWithoutLocalPaths`、`snapshotText` 等后处理函数挪到 `deliverable-check.ts` 旁边，归一处（**精修**，0.5 人日）。
- 验证：b42-quality-line、b41-reply-local-paths 用例。

### 1.5 重试与拒绝处理【已核实】
- 现象：`withBoundedRetry`（executor.ts:186-198，"仅对供应商不可用重试，最多 3 次"）只用于旧 S1b/S2/S6 路径；Agent 路径的 429/500 由 kap-host / 网关处理。`agentFailureText`（:1953）用正则把 `429|rate.?limit|queue_timeout|排队超时` 翻成律师话。
- 证据：进度文档第 41 批"429×3、500×2、上游不回应×1 注入后任务照常成功"。
- 判断：重试链已被真实注入验证，**保留**。唯一缺口是"拒绝（content refusal / 上游拒绝）"没有统一语义：主轮、复核轮各自处理，复核轮拒绝被当作"跳过"（见 1.3）。
- 建议：**精修**——在阶段运行器里统一"拒绝"的终态映射（主轮→失败、复核→部分完成）。

### 1.6 D-173 宿主代为通过计划确认、D-171 事件序号每次尝试后移 1,000,000【已核实】
- 现象：`ATTEMPT_SEQ_SPAN = 1_000_000`（executor.ts:125）；各阶段事件用硬编码序号段：主轮镜像 `10_000 + ev.seq`、修改轮 `fixMirror: 30_000`（:1448）、修订稿段 `mirror: 50_000`（:968），固定事件 9_001/9_002/9_050/9_060～9_062/9_100～9_106/9_200/9_300。
- 根因：事件表以（任务，序号）去重，阶段越加越多，只能在序号空间里手工划段。
- 风险【推断】：主轮宿主事件超过 20,000 条会与修改轮镜像段重叠；修改轮产出超过 100 条 artifact 事件会撞到 9_300。当前任务量远达不到，但每加一个阶段就要再划一段，是脆弱设计。
- 建议：**重构（小）**——事件主键加 `stage` 列（或 `stage_seq`），阶段号代替序号段；随阶段运行器一起做。迁移 1 个。
- 验证：b41-retry-review-session、事件时间线界面回归。


### 1.7 成果入库检查点命中后跳过修订稿段与复核【已核实】
- 现象：`executor.ts:1084-1105`：重跑时若 `step_checkpoints` 里有 `agent_store_draft`，校验成果哈希后**直接 `stepSettle` 并 return**；修订稿段（:1306 `runRedlineStage`）与独立复核（:1312 `runReviewStage`）都在检查点之后、只在首跑路径上执行。
- 引原文：`if (!valid) throw new NeedsReconciliation(...); assertNoUnresolved(); await ctx.step("settle", ...); return;`
- 根因：检查点设计于第 4～12 批"单段 Agent"时代（S5 断点续跑），第 38 批（复核）和第 41 批（修订稿段）把新阶段接在检查点之后，但没有各自的检查点——典型的"后加阶段没回头改恢复语义"。
- 影响：进程崩溃或对账后重跑，任务直接记成功/部分完成，律师拿到的是**未复核**成果，且无任何提示。
- 建议：**重构（小）**，随阶段运行器一起做：每个阶段一个检查点（`redline_stage`、`independent_review` 已经用 `ctx.step` 包了，`ctx.step` 本身有重放语义——【推断】只需把检查点命中分支从"直接 settle"改为"跳过主轮、继续后续阶段"）。
- 成本：约 1 人日 + 用例（模拟主轮后崩溃再 retry，断言复核事件存在）。风险低。
- 验证：新增用例"检查点命中后仍执行 independent_review"；`b41-retry-review-session` 不回退。

---

## 2. 重复逻辑、无效抽象、过度封装（问题 2）

### 2.1 执行器三份轮询循环 + 三段几乎相同的阶段函数【已核实】
- 现象：`executor.ts` 三处 `for (;;) { await new Promise((r) => setTimeout(r, 800)); ... }`：主轮 :1145、修订稿段 :1379、修改轮 :1864。三段都做同样的事：查取消 → 等待态延长时限 → 判总时长 → `agentClient.poll` → 镜像时间线事件（只是序号偏移不同：`10_000+seq` / `REDLINE_SEQ.mirror+seq` / `REVIEW_SEQ.fixMirror+seq`）→ 判终态 → finally 里 cancel。
- 引原文（修订稿段与修改轮几乎逐字相同）：`if (current.status === RunStatus.waitingApproval || current.status === RunStatus.waitingInput) deadline += now - last; last = now; if (now > deadline || now > t0 + p.wallMs) break;`
- 根因：每批加一个阶段时复制上一段（第 38 批复制主轮成复核修改轮，第 41 批再复制成修订稿段）。executor.ts 2,288 行、**41 次 fix**（第二热点）。
- 建议：**合并**——抽一个 `runAgentStage({ prompt, limitMs, seqBase, planMode, continueSession })`，三段调用它；阶段顺序由数组描述。这就是上一轮提出的"阶段运行器"，我独立判断同意，并且认为它是本次 V18 收益最高的一项代码整理。
- 预期收益：executor.ts 预计减 250～350 行；以后加阶段只加一行配置；1.1/1.2/1.5/1.6/1.7 五个问题一并解决。
- 范围/成本/风险：仅 executor.ts（+可能 run-progress.ts）；2～3 人日；风险中——执行器是真实路径核心，必须靠现有用例 + 一轮真实界面复验（审合同+修订稿、起草+复核各 1 单）。
- 验证：kernel 全量用例；`b41-redline-stage`、`b41-retry-review-session`、`b38-independent-review`；eval 流水线跑 5 张卡分数不降。

### 2.2 旧场景执行路径（S1b / S2 / S6）与 Agent 路径并存【已核实】
- 现象：executor.ts:2254-2260 按 `run.scenario` 分派到 `runAgentScenario` / `runS1bScenario`（:660）/ `runS6Scenario`（:751）/ `runS2Scenario`（:806），最后还有 `stepModelReview`（:443）的"老 S1 流水线"。`withBoundedRetry` 只在 :401、:485（老路径的引用核验和模型审查）用。
- 证据：grep 计数——`s1b.draft_compare` 桌面端 4 个文件、`s2.case_file` 6 个、`s6.redaction` 2 个，仍在 `ScenarioStart.tsx`、`RunSheet.tsx` 中引用；`lib/search.ts:16` 有 `LEGACY_SCENARIO_NAMES`。
- 判断：S1b（回稿比对）、S6（脱敏）、S2（案卷整理）是确定性流程，**不需要**改成 Agent；它们走固定步骤是对的。但 :2258 之后的"老 S1 流水线"（`stepVerifyCitations` → `stepModelReview` → `stepStoreDraft`）是否还有入口【未找到】桌面端发起它的场景名，需主评审确认。
- 建议：**保留** S1b/S2/S6；对老 S1 尾巴 **删除（待确认无入口后）**。
- 验证：grep 确认无 scenario 指向；删除后全量用例。

### 2.3 界面 `src/api.ts` 与内核 `api/index.ts` 的一一转抄【已核实】
- 现象：内核 `packages/kernel/src/api/index.ts` 5,207 行、181 个方法键（`"matters.create": (body, id) => {...}`）、**46 次 fix（第一热点）**；界面 `apps/desktop/src/api.ts` 1,438 行，`export const api = {…}`（:756 起）约 178 个包装方法，加 65 个手写 `export interface/type`，39 处 `any`。界面不 import 内核类型（grep `@zr-legal/kernel` 在 desktop/src 为 0）。
- 根因：§1.1 要求渲染进程只经 IPC 调用、不直接依赖内核包，于是响应类型在界面侧手抄。
- 判断：这是"无类型边界"导致的维护成本（23 次 fix 落在 api.ts，多数是字段跟着内核改），不是过度封装。包装层本身有价值（处理保存对话框、浏览器下载回退等，如 `archiveMatter`）。
- 建议：**暂缓**大改；**精修**一步——内核 api 方法的响应类型放进已有的 `@zr-legal/domain`（纯类型、无运行时依赖，不破坏 IPC 边界），界面 `import type`。可以按页逐步迁，不一次性做。
- 成本：每页 0.5 人日，可分批；风险低（只是类型）。
- 验证：`npm run typecheck` 通过；字段改名时界面编译失败而不是运行时 undefined。
- 另：内核 `api/index.ts` 5,207 行单文件是第一热点【已核实】。**精修**：按领域拆成 `api/matters.ts`、`api/runs.ts`…（`api/w1.ts` 已是先例），纯搬家；收益是减少多人并行冲突（见记忆"并行会话共享暂存区"事故）。1～2 人日，风险低。

### 2.4 `dev/bridge.ts` 与 `electron/main.cjs` 双份接线【已核实，结论：问题不大】
- 现象：`apps/desktop/dev/bridge.ts` 仅 111 行，用通用 `POST /invoke {method, params}` 包内核；main.cjs 用 `ipcMain.handle("kwl:invoke", (e, method, params) => …)`（:656）——两边都是**通用分派**，没有逐方法转抄。重复的只是"身份变更后重建内核"（bridge.ts `kernel.restart_for_identity` / `kernel.adopt_master_key` 分支）这 ~20 行。
- 建议：**保留**。最多把"重建内核"抽成 kernel 包导出的一个 `createRestartingKernel()`（**精修**，0.5 人日，可不做）。

### 2.5 多套签名 / 密钥 / 鉴权包是否可并【已核实】
- 现象：keys（1,906 行，Ed25519 签名、设备密封、事项密钥、Shamir 恢复、`canonicalJson`）、seat-token（135）、service-auth（90，HMAC）、ops-auth（997，运营名册与请求签名）、firm-trust（1,600，控制面信封、审计链、入组）、cp-signer 服务（1,284）。
- 证据：底层原语已统一——content-dist、egress、firm-trust/envelope、firm-trust/request-auth 都 `import { canonicalJson, verifyBytes } from "@zr-legal/keys"`。各包定义的是**不同信任根的不同文档格式**：席位令牌（控制面→网关离线验签）、运营名册（安全管理员→云服务）、控制面信封（控制面→律所）、内容清单（内容签名密钥→客户端）。
- 判断：这是按信任边界拆的，合并反而会让"哪把钥匙能签什么"变模糊；不属于重复。唯一可疑的是 `service-auth`：注释写"v0 开发形态 … 共享密钥来自环境变量。生产替换为 OAuth/OIDC"，但它实际被内核 `identity.ts`、`tools/registry.ts`、`local-server.ts` 用作**本机 MCP 能力令牌**（真实路径）。注释已过时，用途其实是进程内/本机令牌，HMAC 足够。
- 建议：**保留**分包；service-auth **精修**注释（写清"本机进程间能力令牌，不跨网络"），10 分钟。

### 2.6 令牌化调用点分散在 13 个文件、多种模式【已核实】
- 现象：`grep tokenize(|detokenize(` 在 tokenizer 包外命中 13 个文件：egress-gate（chat-payload、search-guard、url-guard）、kernel（api/index、api/w1、egress/matter-tokens、executor、local-server、qa-chat、review-cards、review-tables、structured-patch、tools/review、tools/revise）。D-157（assistant 消息 `knownOnly`）、D-172（复核请求"整段只替换已知名单"）、D-177（源自原件的文书"先完整识别再按已知名单替换"）三次偏离都在给不同调用点加不同模式。
- 根因：令牌化从"出站闸门一处"扩散成"各业务点自己决定识别强度"，每加一个出站路径就要再判断一次该用哪种模式——这正是 names.ts 20 次 fix、D-172/D-177 安全评审 H1/H2/M1 的来源。
- 建议：**重构（中）**——在 tokenizer 包导出 2～3 个命名明确的入口（`tokenizeOutbound(text, ctx)` = 闸门默认；`tokenizeKnownOnly(text, table)`；`tokenizeSourceDerived(source, text, table)`），调用点只选入口不传 options；配合上一轮"名单为主"的方向（见第 4 节）。
- 成本：2～3 人日；风险中（安全相关）——必须保留 egress-gate 端的统一兜底。
- 验证：`b41-source-known-only`、`b41-review-known-only`、egress-gate 用例全过；泄露扫描 0。


### 2.7 老 S1 固定流水线（`s1.contract_review`）只剩测试在用【已核实】
- 现象：内核 `api/index.ts:194 const SCENARIOS = new Set(["s1.contract_review", "s1b.draft_compare", "s2.case_file", "s6.redaction", "a1.agent_task"])` 仍接受 `s1.contract_review`，执行器落到 :2258 起的"载入材料→引用核验→模型审查→生成交付件"老流水线；桌面端 `lib/scenarios.ts` 无任何卡片发起它（grep 0），只在 `labels.ts:79`、`badges.ts:31` 做历史显示。**29 个测试文件**引用它。
- 根因：A1 Agent 路径（第 4～5 批起）替代后没下线，测试把它当成"通用运行机制"的夹具。
- 建议：**暂缓删除，冻结**——不再修它；V18 若做阶段运行器，可顺手把 29 个测试改用 a1 夹具后删除老流水线（`stepVerifyCitations/stepModelReview/stepStoreDraft` 约 250 行 + `withBoundedRetry`）。
- 成本：测试迁移 1～2 人日；风险低。

---

## 3. 复杂设计与业务价值（问题 3）

判定口径：**真实路径** = 桌面安装包运行时会执行到；**可选上游** = 只有 release.json 配了对应 `ZR_*_BASE` 才会连（`apps/desktop/electron/release-config.cjs` 定义了 control_plane/dist/gateway/notify/relay/search/support 七个 base），而 D-160 试用版"不带云端上游"；**只测试** = 只有用例引用；**只构建** = 打包但不启动。

### 3.1 总表

| 包 / 服务 | 自有行数 | 是否在真实执行路径（证据） | 律师可感知价值 | 建议 |
|---|---|---|---|---|
| kernel | 72.7k | 真实路径（main.cjs 拉起） | 核心 | 保留；精修 api/index.ts 拆分、executor 阶段运行器 |
| kap-host（自写部分） | ~1万 | 真实路径（kap-agent-client.ts、main.cjs） | 核心（Agent 执行） | 保留 |
| kap-host/vendor | 30.8万 | 第三方 Kimi Code 构建产物 | 核心 | 保留；从行数统计剔除 |
| docx-engine | 6.8k | 真实路径（内核 21 文件引用） | 高（Word 交付件） | 保留 |
| exec-wasm（W-core） | 5.2k | 真实路径：`kap-host/src/main.ts:45 execDomain?: "w-core" \| "none"`，缺省 W-core | 中（代码执行能力，律师间接感知：表格计算、批量处理） | 保留（2 个提交、0 次 fix，最稳定的包之一） |
| egress-gate | 6.7k | 真实路径（唯一出口进程，35 提交、最近 11-11 仍在改） | 隐性高（合规卖点） | 保留；relay 子模块随对应云服务冻结 |
| egress | 0.4k | 真实路径（去向记录） | 隐性 | 保留 |
| tokenizer | 4.6k | 真实路径 | 隐性高，但误认直接影响文书可读性 | 重构入口（2.6）+ 名单为主（4.3） |
| keys / at-rest / file-broker / host-policy | 1.9k/0.6k/1.6k/0.3k | 真实路径（kap-host、exec-wasm、内核） | 隐性（落盘加密、文件隔离） | 保留 |
| lawdb / parse-ocr / model-broker / safe-log / domain / pseudonym / service-auth / design-tokens | 小 | 真实路径 | 中～高（法规核验、OCR） | 保留 |
| content-dist | 0.4k | 真实路径（内核 content-updates.ts）；但更新源需 dist_base | 中（法规库、方法更新） | 保留 |
| firm-trust | 1.6k | 真实路径但只在"控制面模式"（内核 control-plane/*、onboarding.ts） | 律所管理员可感知（入组、策略） | 保留 |
| seat-token | 0.1k | 内核 governance + 全部云服务 | 隐性 | 保留 |
| sync + 内核 sync-engine/share-relay/member-log | 0.2k + ~4.8k（栈合计 5,064 行，含 relay-api） | **可选上游**：`TeamShare.tsx` 在 `st.blocked === "not_configured" && alerts.length===0` 时 `return null`；只在 `inFirm` 且配了 relay_base 时出现 | 低（团队共享事项，目前无部署证据） | **冻结**（见 3.2） |
| relay-api | 1.3k | 可选上游（cloud-serve.mjs 拉起；无 src 引用） | 同上 | 冻结 |
| notify-api | 0.8k | 可选上游 | 低（提醒推送；本机提醒已可用） | 冻结 |
| support-api | 0.7k | 可选上游 | 低～中（工单/诊断上传） | 冻结 |
| search-service | 0.3k | 可选上游 | 中（联网检索），但需部署 | 保留，部署前不再投入 |
| control-plane / legal-gateway / dist-api | 7.5k/2.0k/0.2k | 可选上游；gateway 是商用版 token 供给的必要件 | 商用必须 | 保留 |
| cp-signer | 1.3k | 无任何代码引用（独立签名进程，cloud-serve.mjs 拉起）；最近一次改动 10-21 | 无直接感知 | 冻结 |
| blob-store | 0.7k | 只 cp-signer/archive、support-api、cloud-serve | 无 | 随 support-api / cp-signer 冻结 |
| ops-auth / ops-console | 1.0k / 静态页 | 只云端服务与 ops 脚本；ops-console 第 40 批改动未合并 | 运营可感知，律师不可感知 | 保留（商用运营必须），不再扩 |
| **firm-node** | 0.5k | **只构建不运行**：`scripts/build-kernel.mjs:118-119` 打包成 `electron/firm-node.bundle.mjs`，但 main.cjs、package-desktop.mjs 都 grep 不到启动它；源码自述"v0 边界…G1"；2 个提交，最近 10-14 | 无 | **删除或移出构建**（见 3.3） |
| **im-connectors** | 0.6k | **只被 firm-node 引用**（`apps/firm-node/src/im-runtime.ts`）；1 个提交（10-09） | 无 | 随 firm-node 删除/冻结 |
| RecallEval 页 | 614 行 | 真实路径，但只在设置→管理员子页"代号准确度"（`Connections.tsx:694/723`）；7 个 `api.eval*` 方法 | 律师不可感知；对**提升令牌化准确度**是唯一的所内量化工具 | 保留但冻结；若采纳"名单为主"，它是验证工具，反而有用 |
| Boards 页 | 174 行 | 路由保留但侧栏已撤（`Sidebar.tsx:18` "'看板'与首页、事项页重复，不再占一级入口"） | 低 | **删除**一级页面（事项页内的看板保留） |
| 仓库根目录早期演示（app.js、legal-*.js、*.html 等） | 4,703 行 | 不在 platform 任何构建或测试里（grep 0）；最近改动 `4fee2e5` 2026-09-22 | 无（09 月演示） | **移到 archive/ 或删除**（3.4） |

### 3.2 团队共享 / 同步栈：最重的"无部署价值"子系统【已核实事实 / 推断价值】
- 现象：sync-engine.ts 1,357 行 + share-relay.ts 1,217 行 + member-log + packages/sync + relay-api，合计 **5,064 行源码**；kernel 测试里 `share*`/`member*` **21+6 个文件、4,336 行**；sync-engine.ts **14 次 fix**，提交主题全是第 11～12 批的多轮复核处置（"块按链上纪元加密""报复须看见降级者此前全部作为""撤回'链上标记即吊销'"……第 11 批"第七轮（收口）复核处置"）。
- 根因：v9 第 11/12 批按"多律师端到端加密共享"做了完整的成员日志 + 纪元密钥 + 报复/降级判定，设计复杂度对标分布式系统；而当前产品形态（记忆："云端只供 token、其余本地执行"、试用版不带云端上游）下没有 relay 部署。
- 判断【推断】：律师当前感知不到；它却持续带来维护成本——`residency.json` 33 次 fix 中有一部分、`api/index.ts` 的同步接口、TeamShare 每 15 秒 `api.relayStatus()` 轮询（`TeamShare.tsx` `setInterval(load, 15_000)`）。
- 建议：**暂缓（冻结）**——不删（删除一个经过 7 轮安全复核的协议代价大，且将来律所版可能需要）；V18 明确"冻结"：不再修、不再扩，测试保留但可移出默认全量（单独 `test:share`），节省全量时长。
- 收益：全量测试时长下降【推断】约 10%（4,336 行用例）；后续批次不再被它的回归拖累。
- 验证：冻结后 `git log -- packages/kernel/src/sync-engine.ts` 无新提交；默认全量不含 share*。

### 3.3 firm-node + im-connectors：只构建、不运行【已核实】
- 证据：见总表；`apps/firm-node/src/index.ts` 注释"所内节点（headless 形态，方案 v5.0 …）""v0 边界（如实声明）：LAN 部署与双向证书认证 G1 … 主备仅租约语义 v0 … 跨机器节点加入流程 G1"；`im-runtime.ts`"v0 简化…真实平台凭据与联调属部署工作"。方案已从 v5 演进到 v9.x，"所内节点"形态不在当前方案里。
- 建议：**删除**（或至少从 `build-kernel.mjs` 去掉 firm-node 打包、从 workspaces 移出）。kernel 里 `devices.ts:425` 的 `userSlug === 'node'` 角色可保留。
- 收益：少一个 bundle、少 4 个测试文件依赖、少一个出网面（residency/outbound-surface 测试里有它的条目）。
- 成本：0.5～1 人日；风险低（无运行路径）。注意 `egress-gate/test/outbound-surface.test.ts`、`safe-log/test/log-surface.test.ts`、`keys/test/signer-surface.test.ts` 的清单要同步删条目。
- 验证：build-kernel 不再产出 firm-node.bundle.mjs；全量用例通过；安装包冒烟通过。

### 3.4 根目录早期演示文件【已核实】
- 证据：根目录 `app.js、bootstrap.js、legal-*.js/css、index.html、kimi-work-legal-demo.html、Kimi-Work-Legal-交互演示.html` 合计 4,703 行（js+html），platform 内 grep 无任何引用，最近改动 2026-09-22。根目录另有 `research/`、`video/`、`output/`、`tests/`、`scripts/`。
- 建议：**删除**（移到 `archive/demo-2026-09/`，保留 git 历史即可）。收益：新人与子代理不再误读（记忆里已多次提到"别读根目录"类困扰——【推断】）。成本 10 分钟。


---

## 4. 反复修补、未真正解决的历史问题（问题 4）

先说一个统计口径问题【已核实】：本仓库的 `fix:` 前缀被大量用于功能增量。例如 `docx-engine/src/revise.ts` 的 fix 提交里有"在原件上修订支持表格新增行、删除行与表后插入"（对应偏离 D-164，是新功能），`tools/registry.ts` 的 fix 里有"表格可以逐格修改（xlsx.edit_cells）"（D-169，新工具）。所以"fix 次数"偏高估了缺陷；下面逐个判断"设计问题"还是"正常迭代"。

### 4.1 热点前 15 与判断

| # | 文件 | fix 次数 | 反复修的主题（git log 摘） | 判断 |
|---|---|---|---|---|
| 1 | kernel/src/api/index.ts（5,207 行） | 46 | 复核处置（Q4～Q6）、成果文件名里的隐私代号、导出不套函头、版本比较、重新运行接回会话 | **设计问题（结构性）**：单文件承载 181 个方法，任何功能都要碰它；拆文件（2.3）可降冲突，但主题本身是正常迭代 |
| 2 | kernel/src/executor/executor.ts（2,288） | 41 | 复核覆盖、修改轮清单、修订稿段、重新运行会话、只替换已知姓名、余额不足提示 | **设计问题**：阶段逐批复制（2.1）、序号段手工划分（1.6）、检查点不覆盖新阶段（1.7） |
| 3 | docs/privacy/residency.json | 33 | 每新增一个本机存储点/出网点就要登记（`privacy-residency.test.ts` 门禁） | **正常迭代 / 好设计**：是"清单即门禁"的预期成本，保留（见第 5 节） |
| 4 | docs/v9-开发计划与进度.md | 25 | 进度登记 | 正常 |
| 5 | apps/desktop/src/lib/scenarios.ts（1,434） | 24 | 开始面板字段、卡片说明、预选文件、方法提示文字 | **半设计问题**：场景卡定义（数据）与面板逻辑混在一个 TS 文件；卡片文案修改占多数——【推断】卡片定义若移到 `content/` 下随方法签名下发，界面不必每次改代码 |
| 6 | apps/desktop/src/api.ts | 23 | 跟着内核字段改 | **设计问题（轻）**：无共享类型（2.3） |
| 7 | tokenizer/src/names.ts（811） | 20 | 全是"××不再认成姓名"：应予返、权限、董事监事、方明、当日、商场…（11-01～11-10 之间 17 条） | **设计问题（核心）**：见 4.2 |
| 8 | kernel/src/services/independent-review.ts | 19 | 复核覆盖范围、意见序号识别、法条原文、只换已知姓名 | **一半设计问题**：自由文本+正则解析（1.3） |
| 9 | kernel/src/index.ts（1,264） | 19 | 装配点 | 正常（装配根本来就常改） |
| 10 | kernel/src/tools/tools/revise.ts | 18 | 补交 amend、表格增删行、对外版保留批注、只换已知姓名 | 正常迭代为主（功能增量记成 fix），D-170 已修掉根因（全量重发） |
| 11 | content/skills/doc-revise/SKILL.md | 16 | 方法正文 | 另组审 |
| 12 | apps/desktop/src/styles.css | 16 | 界面 | 正常 |
| 13 | kernel/src/tools/registry.ts | 15 | 新工具登记、工具锁同步 | 正常（工具锁设计的预期成本） |
| 14 | kernel/src/tools/tools/review.ts | 14 | — | 正常 |
| 15 | kernel/src/sync-engine.ts | 14 | 第 11～12 批七轮复核处置（纪元加密、报复判定） | **过度设计**：无部署却被反复复核（3.2） |
| 16 | kernel/src/services/deliverable-check.ts | 14 | 每批补一种"检查没覆盖到的标记"（事实 N、快照 002、节标题重复、质量说明行） | **正常迭代**：规则检查本就是逐条加；第 42 批数据显示有效（154 份剩 9 份） |

### 4.2 姓名识别：规则打地鼠，已到边际收益为负【已核实】
- 现象：`tokenizer/src/names.ts` 811 行里有 **51 个规则常量**（`STOP`、`GIVEN_NOT`、`NOT_GIVEN`、`FUNCTION_SURNAMES`、`COMMON_WORDS`、`ROLE_FOLLOW_WORDS`、`NICK_EXCLUDE`、`AFTER_NAME_WORDS`、`NOT_NAME_TAIL`、`KNOWN_MISREADS`…），其中 `KNOWN_MISREADS`（:638）就是"见过的误认"黑名单。测试 15 个文件 1,566 行，其中 6 个是按批次命名的误认回归（b34-false-positives、b35-modal-ying、b41-quan-words…）。
- 证据：git log 20 次 fix，主题样例："'被告应予返还'里的'应予返'不再认成姓名"（b37201e）、"'经办人权限'…里的'权限'不再被认成人名"（d19c55a）、"'当事人一方明确表示'里的'方明'不再被认成姓名"（ecf8f07）。偏离 D-150（偏召回）→ D-162（弱证据偏精确）→ D-157/D-172/D-177（不同出站点不同模式）三次改口径。
- 根因：在没有名单的地方用字级规则从自由文本里"发现"中文姓名，本质是开放集 NER；每条规则修一个误认又可能引入新漏认。而产品里**已有**名单来源：事项当事人词典（`matters.parties.*`）、令牌表、表头/角色强证据——D-177 已经是"先完整识别原件写回代号表，再按已知名单替换"。
- 判断：这是一直没真正解决的问题。上一轮"名单为主"方向我独立同意，补充一点：**召回的责任应前移到"材料入库时"一次性识别 + 律师在当事人词典确认**，出站时只按名单替换（knownOnly），规则识别只作为"疑似新姓名"提示而不自动替换模型输出。
- 建议：**重构（中）**——不是重写 names.ts，而是改它的使用位置：入库识别（全规则，结果进词典待确认）→ 出站 knownOnly（已经是 D-157 的 assistant 消息路径）。user 消息（材料原文）在入库时已识别过，出站不再二次识别。
- 收益：后续"××不再认成姓名"类修复预计大部分消失【推断】；模型输出里普通词被替换成代号导致的文书可读性问题消失。
- 风险：**安全相关**——漏认的姓名会明文出站。必须：(1) 入库识别保持当前召回口径（不降）；(2) RecallEval（3.1 表）在此正好用于量化前后召回；(3) egress-gate 保留"知名单+强证据"兜底。
- 成本：3～5 人日 + 一轮召回评测。
- 验证：RecallEval 召回不降；eval 流水线里"代号进成果"类扣分归零；泄露扫描 0。

### 4.3 "提示词掩盖"的典型【已核实】
- D-174/D-176 + 第 42 批 `scrubQualityLine`：先写进方法与工作准则（提示词），再由内核兜底删除；第 42 批数据"真实任务 20 单最终成果 0 处"说明提示词已生效、兜底留作保险——这是**健康**的两层，不算掩盖。
- 真正被提示词掩盖的是：**时限**（D-163 修改轮提示"告诉助手本轮时限，先改必须改的"，dd9cda2）——用提示词让模型赶工来对付时限过紧，根因是阶段时限各自独立（1.1）。
- 独立复核"遇上游拒绝即跳过而任务仍记成功"——第 42 批明确"看到、未修"。**应在 V18 修**（1.3）。


---

## 5. 已足够成熟、应当保留的实现（问题 5）

证据：按包统计 `src/` 下提交数、fix 数、最后一次 fix 日期、测试文件数【已核实】（`git log -- <pkg>/src`）。注意早期有"第 4-5 批""阶段 7-12"这类大合并提交，"提交数=1"表示自导入后再没动过。

| 模块 | 提交 / fix | 最后 fix | 测试文件 | 判断 |
|---|---|---|---|---|
| exec-wasm（W-core 执行域） | 2 / 0 | 无 | 8（含 w-legal-tasks、w-s3-regressions） | **保留**：真实路径缺省执行域，导入后 0 返修；也是 Windows CI 关键用例 |
| at-rest（落盘加密） | 1 / 0 | 无 | 1 | **保留** |
| file-broker | 1 / 0 | 无 | 1 | **保留** |
| host-policy | 1 / 0 | 无 | 1 | **保留** |
| egress（去向记录） | 2 / 0 | 无 | （由内核/闸门用例覆盖） | **保留** |
| keys | 5 / 1 | 10-19 | 9 | **保留**：签名原语已被各信任边界复用（2.5） |
| content-dist / seat-token | 2 / 1 | 10-15 / 10-16 | 1 / 1 | **保留** |
| parse-ocr | 5 / 2 | 11-03 | 4 | **保留** |
| kap-host 嵌入 + engine-drift 工作流 | 11 / 5 | 11-10 | 12 | **保留**：上游 tag + 补丁台账 + 漂移用例，是"内嵌第三方 Agent"的正确做法 |
| egress-gate 核心（server/chat-payload/url-guard/tls-check） | 25 / 13 | 11-11 | 24 | **保留**：fix 多数是"新增出站路径/令牌范围"，不是闸门本身缺陷 |
| docx-engine（除 revise.ts） | 51 / 38（revise.ts 占 13） | 11-10 | 19 | **保留**：第 32～34 批 Word 表格、自动编号、版式在真实 Word 实开验证过（记忆：v9.4-b33 行跨页修正）；revise.ts 仍在功能增长期 |
| 交付前检查 deliverable-check | 14 fix | 11-12 | b41/b42 用例 | **保留**：第 42 批回放 154 份成果，检查报出后模型基本都改了 |
| 驻留面清单 residency.json + privacy-residency 用例 | 33 次随功能更新 | — | 门禁用例 | **保留**：清单即门禁，每次新增存储点都被迫登记，是商用合规的可审计证据 |
| 工具锁（tool-manifest lock，`kernel/src/tools/manifest-lock.ts`） | — | — | — | **保留**：偏离表 D-164/D-165/D-169/D-170 每次改工具入参都写"工具锁 schemaHash 同步…须双人评审"，说明它确实在拦 |
| 验收流水线 platform/eval（第 42 批） | 新 | — | — | **保留**：首次让质量判断可复现（同 10 份两次评分平均差 0.5） |
| 测试共享夹具 | — | — | `kernel/test/helpers.ts`、`stub-kap-host.ts`、`cloud-v0.ts` | **保留**：137 个内核用例 import 共享 helper，只有 3 个自建 setup——夹具并不散乱 |

---

## 6. 测试与工程效率（问题 6）

### 6.1 全量 13.4 分钟的主要原因是 `--test-concurrency=1`【已核实】
- 证据：`platform/package.json:23 "test": "node --test --test-concurrency=1 …"`；第 42 批记录"全量用例 2,248 例…"。393 个测试文件串行跑。
- 根因【推断】：早期用例共用端口/工作区/环境变量（如 `ZR_DB_KEY`），并发会互相踩，于是全局串行。
- 建议：**精修**——先用 watchdog 输出每文件耗时，挑出共享全局状态的文件标记串行，其余并发 4；预计全量降到 4～6 分钟【推断】。
- 成本 1～2 人日；风险：暴露潜在的用例间依赖（这本身是收益）。
- 验证：并发跑 3 次全绿、与串行结果一致。

### 6.2 按批次命名的测试文件【已核实】
- 证据：393 个测试文件中 **109 个**以批次/阶段前缀命名（`b34-`、`b41-`、`v94-`、`p12`…）；内核 214 个里 b41 16 个、b39 10 个、b35 7 个、b38 6 个；tokenizer 15 个里 6 个批次名。
- 判断：批次名让"这个用例测什么、某功能的用例在哪"必须靠 grep；但重复覆盖【未找到直接证据】——夹具共享良好（5 节），批次用例多是端到端回归，与功能用例互补。
- 建议：**暂缓**大规模改名（会毁掉 git blame 与进度文档里的引用）；**精修**规则：新用例按功能命名，批次号写进 `describe` 标题；旧文件只在被大改时顺手改名。
- 例外：share*/member* 27 个文件 4,336 行随 3.2 冻结，移出默认全量（`test:share`）。

### 6.3 CI 现状【已核实】
- `.github/workflows/` 只有两个：`engine-drift.yml`（PR 与推送、仅 kap-host/third_party 路径变更时跑两个用例）、`windows-desktop.yml`（**只在推送 main** 时跑；关键用例 + 中文路径 + 全量信息性 `continue-on-error: true` + 打包冒烟）。
- 缺口：**没有任何 Linux/macOS 全量用例的 CI**——全量只在本机跑，PR 阶段不跑全量；Windows 关键用例 `timeout-minutes: 240` 仍保留，看门狗"Windows CI 未跑、真机未装"（第 42 批）。记忆里还记录过 CI 曾因 GitHub 付款问题失败。
- 建议：**精修**——加一个 ubuntu PR 工作流跑 `npm test`（并发后 <10 分钟）；Windows 关键用例 timeout 在看门狗跑通一次后降到 60 分钟。成本 0.5 人日。
- 验证：一次 PR 触发两套工作流都绿。

### 6.4 新 worktree 上手成本【已核实 / 部分引用既有结论】
- `pretest` 会依次 `build:lawdb && build:agent-profile && build:tool-manifest && build:skills`；开发签名密钥由 `content/lawdb/lib/build-util.mjs` 用 `generateKeyPairSync` 缺失时自动生成（`content/keys/` 在 .gitignore）；OCR 模型需 `npm run fetch:ocr-models` 单独下载（`content/ocr-models/` 被 .gitignore）。
- 已知坑（记忆"新 worktree 跑内核用例要先备 pretest 产物"）：缺法规库、模板、密钥、OCR 模型时内核用例**挂起不报错**——单文件 `node --test x.test.ts` 不会触发 pretest。这与 Windows 240 分钟挂起可能同源【推断】。
- 建议：**精修**——在 `kernel/test/helpers.ts` 加一次性前置检查：产物缺失直接 `throw`（写明"先运行 npm run pretest / fetch:ocr-models"），把"挂起"变成"秒失败"。成本 0.5 人日，收益高。
- 验证：删掉 `content/lawdb/dist` 后跑任一内核用例，10 秒内报错。

---

## 7. 安全与合规机制的成本（问题 7）

只给判断，不建议削弱边界。

| 机制 | 位置（已核实） | 商用必须？ | 层次是否叠多 | 判断 |
|---|---|---|---|---|
| 出站闸门（独立进程、唯一出口） | egress-gate 6.7k；内核 `egress/kernel-gate.ts` 595 + `gate-host.ts` 565 拉起与授权 | **必须**（合规卖点、律协指引） | 否：kernel-gate=拉起与凭据下发，gate-host=任务令牌活性核验，egress-gate=实际出站，职责不同 | 保留 |
| kap-host 宿主出口路由 | `kap-host/src/host-egress.ts` 257 行；自述"这是**应用层路由**，不是隔离：同进程代码若直接使用原生 `net` 仍可直连" | 必须（把 Kimi Code 的请求接到闸门） | 否，但如实承认不是强隔离 | 保留；强隔离（OS 出站规则）属后续 |
| 令牌化（出站） | 闸门 `chat-payload.ts` + 内核 13 个调用点（2.6） | **必须** | **是**：同一段文字可能在内核侧先令牌化、闸门再按范围处理，靠 D-172 的"令牌范围"标记协调——两层之间有隐式协议 | 收入口（2.6）+ 名单为主（4.2）；闸门兜底不动 |
| 落盘加密 at-rest + sealed-storage + file-broker | at-rest 573、kap-host sealed-storage 488、file-broker 1.6k | 必须（律所数据） | 否；0 返修 | 保留 |
| 工具锁（manifest-lock + schemaHash） | `kernel/src/tools/manifest-lock.ts`、`content/tool-manifest/build-lock.mjs` | 必须（防工具面漂移） | 否 | 保留；代价是每加工具要重签，可接受 |
| 驻留面清单 + 出网面/日志面/签名面"surface"用例 | residency.json；`egress-gate/test/outbound-surface.test.ts`、`safe-log/test/log-surface.test.ts`、`keys/test/signer-surface.test.ts` | 必须（可审计） | 否 | 保留；清理 firm-node 等时同步删条目 |
| 控制面签名信封 / 运营名册 / 席位令牌 | firm-trust、ops-auth、seat-token | 商用云端必须 | 否（不同信任根，2.5） | 保留 |
| 团队共享端到端加密（纪元密钥、成员日志） | sync 栈 5k 行 | **当前非必须**（无部署） | 是（对当前形态是过度） | 冻结（3.2），不削弱、不删除 |
| W-core 执行域 | exec-wasm | 必须（模型写代码时的隔离） | 否 | 保留 |

结论：除"令牌化入口分散"外，安全层次没有明显的重复叠加；成本主要来自**未部署子系统仍在被同等标准复核**（sync 栈七轮复核、residency 里的 firm-node 条目），而不是在用的机制本身。


---

## 补充 2.8 场景卡与方法元数据两处定义；提示词长句写在执行器里【已核实】
- 现象：方法"主交付物"在两处定义——`content/skills/build-skills.mjs:74` 从 SKILL.md 前言读出 `primary_output`；界面 `apps/desktop/src/lib/scenarios.ts` 又有 `primary?: string`、`primaryBy?: {field,map}`（:65-70），并在 :524 注释"第 31 批：方法前言 outputs 第一项是申请书，不写 primary 时提示词会把'主交付物'说成申请书"——界面手工覆盖方法元数据。scenarios.ts 45 个 `skill:` 卡片、24 次 fix（第 5 热点）。另外 `executor.ts:1003` 的 `methodPromptLine` 把一整段约 300 字的交付约束（"必须用 docx.render_report 生成…正文不留【待确认】…"）写死在执行器代码里，与工作准则 AGENTS.md 的条款重叠。
- 根因：早期方法前言字段不全，界面先行补洞；提示词随修复就近写进内核。
- 建议：**精修**——主交付物只认 SKILL.md 前言（缺的补前言），界面读签名后的 skills 清单；`methodPromptLine` 里的通用约束移入 AGENTS.md（另组审提示词时一并处理）。卡片文案也可随方法包下发，减少界面发版。
- 成本 1～2 人日；风险低（需回归 b31/b34 主交付物用例 `primaryDeliverableMissing`）。

---

## 8. 按"收益 / 成本"排序的前 10 条建议

| # | 建议 | 类型 | 成本 | 收益 | 对应条目 |
|---|---|---|---|---|---|
| 1 | 测试前置检查：pretest 产物/OCR 模型缺失时秒失败而非挂起 | 精修 | 0.5 人日 | 新 worktree 与 Windows CI 挂起类问题直接可定位 | 6.4 |
| 2 | 独立复核遇上游拒绝时任务记"部分完成·复核未做" | 精修 | 0.5 人日 | 终态如实，堵一个已知未修缺口 | 1.3、4.3 |
| 3 | 删除 firm-node + im-connectors（或移出构建），同步删各 surface 清单条目 | 删除 | 0.5～1 人日 | 少一个 bundle、少一个出网面 | 3.3 |
| 4 | 根目录早期演示文件移入 archive/ | 删除 | 10 分钟 | 降低误读 | 3.4 |
| 5 | 加 ubuntu PR 全量 CI；Windows 看门狗跑通后把 240 分钟降到 60 | 精修 | 0.5 人日 | 合并前有全量门禁 | 6.3 |
| 6 | 执行器阶段运行器：三份轮询循环合一 + 阶段时限表 + 每阶段检查点 + 阶段号代替序号段 | 合并 | 2～3 人日（+ 真实复验） | 一次解决 1.1/1.2/1.5/1.6/1.7/2.1；executor.ts 预计 -300 行 | 2.1 |
| 7 | 同步/团队共享栈冻结，share*/member* 用例移出默认全量 | 暂缓（冻结） | 0.5 人日 | 全量提速、后续批次不再被拖 | 3.2 |
| 8 | 测试并发（`--test-concurrency` 从 1 提到 4，串行名单例外） | 精修 | 1～2 人日 | 全量 13.4 → 约 5 分钟【推断】 | 6.1 |
| 9 | 令牌化入口收成 2～3 个命名函数 + "名单为主"（入库识别、出站 knownOnly） | 重构 | 3～5 人日 + 召回评测 | 终结 names.ts 打地鼠；文书可读性 | 2.6、4.2 |
| 10 | 内核 `api/index.ts` 按领域拆文件；响应类型移入 `@zr-legal/domain` 供界面 `import type` | 精修 | 2～3 人日（可分批） | 第一、第六热点的冲突与字段漂移下降 | 2.3 |

次一档：复核意见结构化输出（1.3）；主交付物单一来源（2.8）；老 `s1.contract_review` 流水线迁测试后删除（2.7）；Boards 一级页删除（3.1）；service-auth 注释更正（2.5）。

## 9. 明确"不值得动"的清单
- kap-host vendor（30.8 万行 Kimi Code 构建产物）与 engine-drift 机制——正确做法，别动。
- 签名/密钥/鉴权分包（keys、seat-token、ops-auth、firm-trust、cp-signer）——按信任根拆分，原语已共享，合并只会模糊边界。
- exec-wasm、at-rest、file-broker、host-policy、egress——导入后 0 返修。
- egress-gate 三层（kernel-gate / gate-host / 闸门进程）——职责不同，不是重复。
- 交付前检查与 `scrubQualityLine` 等内核兜底——命中趋零正说明有效，删了是赌提示词。
- residency.json + surface 用例、工具锁——合规门禁的预期成本。
- `dev/bridge.ts` 与 main.cjs——通用分派，只有 ~20 行重建逻辑重复，不值得抽。
- S1b / S2 / S6 确定性流程——不需要 Agent 化。
- 批次命名测试的大规模改名——成本大于收益，只立新规。
- D-178 两段语义本身（用户已拍板）——只改实现方式，不改行为。
- 同步栈——冻结，不删除（经过七轮安全复核，未来律所版可能要）。

## 10. 未查 / 未能核实
- 老 `s1.contract_review` 流水线除测试外是否还有其他发起入口（如 API 旧客户端、导入的历史任务重跑）——只确认桌面端 scenarios.ts 无卡片。
- kernel 13 个令牌化调用点各自是出站还是入站（显示用 detokenize）——未逐个读，2.6 的"重复层"判断部分为推断。
- 测试并发的实际可行性（哪些文件共享全局状态）——未跑。
- 云端服务是否有任何实际部署（relay/notify/support/search）——仓库内无证据，按"可选上游、试用版不带"判断。
- `apps/desktop` 内部（RunView 1,235 行、Connections 1,340 行）的组件重复——未细看。
- 仓库根 `tests/`、`scripts/` 的内容与是否仍被使用——未查。
