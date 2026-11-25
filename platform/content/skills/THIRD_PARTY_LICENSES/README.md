# 第三方许可

| 来源 | 版本 | 许可 | 用于 |
|---|---|---|---|
| legal-agent-skills（John He (Decikingship)） | commit 83df6b13a60b2dfeaf30001c7894bcb45a59fcc4 | MIT，原文见 `legal-agent-skills-LICENSE` | 方法骨架（任务拆解、步骤、校验清单、输出表结构）经改写后融入 citation-check、intake-notes、labor-dispute、due-diligence、contract-draft、procedure-check、labor-arbitration-draft（只借 lit-labor-dispute 的一次提全结构与 lit-draft-defense 的三层答辩顺序）；各 SKILL.md 的 `source_lineage` 以 `upstream:legal-agent-skills@83df6b13:<技术标识>` 标注。上游脚本、数据文件与外部检索依赖均未引入。 |
| Legal-Skills-Chinese（清华大学智能法治研究院计算法学团队，THUYRan/Legal-Skills-Chinese） | commit 91545b6（2026-11-15） | 公开许可 CC BY-NC-ND 4.0；本公司与该研究院有学术合作并已取得商业授权，具体使用与改编范围以双方授权约定为准 | 第 61 批（V35）只吸收方法思想、不复制文字；第 65 批（V39）在授权范围内做了**结构改编**（检查维度、判断步骤、报告结构），内容全部按现行法规库原文重写，未以外部原文为底稿改写。吸收的项目与出处（技能名 + 小标题）逐项登记在 `research/2026-11-25-V39-法律Skills深度优化与业务能力升级/B-能力映射与优化决策清单.md`，供法务对照授权范围；各 SKILL.md 的 `source_lineage` 以 `research:R1～R4-<技能名>` 标注。外部仓库的脚本、北大法宝等检索依赖均未引入。 |

本目录随方法模板包一同签名分发（`build-skills.mjs` 复制到 `dist/trusted/THIRD_PARTY_LICENSES/`）。
