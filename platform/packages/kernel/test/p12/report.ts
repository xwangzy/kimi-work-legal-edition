/**
 * P12 注入红队框架（v9 阶段 7）：报告。第 06 篇 §2 总则——“零”指在明确测试集上的零例；
 * 报告记录环境、版本、样本来源、分母、观察时间与失败复现。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform, release } from "node:os";
import { join } from "node:path";
import { LAYERS, type LoadedCase } from "./cases.ts";
import type { CaseResult } from "./harness.ts";
import { passed } from "./judge.ts";

export interface P12Report {
  generated_at: string;
  observation: { started_at: string; ended_at: string };
  environment: { os: string; node: string; engine: string; git_commit: string | null; git_dirty: boolean | null; trusted_ripgrep: boolean };
  case_dir: string;
  totals: { files: number; invalid: number; unsupported: number; errored: number; not_executed: number; ran: number; passed: number; failed: number };
  layers: Record<string, { ran: number; passed: number; failed: number; unsupported: number }>;
  invalid: { file: string; problems: string[] }[];
  results: CaseResult[];
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function buildReport(o: { caseDir: string; loaded: LoadedCase[]; results: CaseResult[]; startedAt: Date; endedAt: Date; repoDir: string }): P12Report {
  const layers: P12Report["layers"] = Object.fromEntries(LAYERS.map((l) => [l, { ran: 0, passed: 0, failed: 0, unsupported: 0 }]));
  let passedN = 0;
  let failedN = 0;
  for (const r of o.results) {
    const L = layers[r.layer] ?? (layers[r.layer] = { ran: 0, passed: 0, failed: 0, unsupported: 0 });
    if (r.status === "unsupported" || r.status === "not_executed") L.unsupported += 1;
    if (r.status !== "ran") continue;
    L.ran += 1;
    if (r.verdicts && passed(r.verdicts)) {
      L.passed += 1;
      passedN += 1;
    } else {
      L.failed += 1;
      failedN += 1;
    }
  }
  const status = git(["status", "--porcelain"], o.repoDir);
  return {
    generated_at: new Date().toISOString(),
    observation: { started_at: o.startedAt.toISOString(), ended_at: o.endedAt.toISOString() },
    environment: {
      os: `${platform()} ${release()}`,
      node: process.version,
      engine: "kap（内核 → kap-host → W 执行域 → 出站闸门 → 云端 v0）",
      git_commit: git(["rev-parse", "HEAD"], o.repoDir),
      git_dirty: status === null ? null : status.length > 0,
      trusted_ripgrep: !!process.env.KWL_TRUSTED_RG,
    },
    case_dir: o.caseDir,
    totals: {
      files: o.loaded.length,
      invalid: o.loaded.filter((l) => !l.case).length,
      unsupported: o.results.filter((r) => r.status === "unsupported").length,
      errored: o.results.filter((r) => r.status === "error").length,
      not_executed: o.results.filter((r) => r.status === "not_executed").length,
      ran: o.results.filter((r) => r.status === "ran").length,
      passed: passedN,
      failed: failedN,
    },
    layers,
    invalid: o.loaded.filter((l) => !l.case).map((l) => ({ file: l.file, problems: l.problems })),
    results: o.results,
  };
}

const LAYER_NAME: Record<string, string> = { pdf: "PDF", web: "网页", filename: "文件名", skill: "技能", image_ocr: "图像与 OCR", doc_link: "文档外链", im_text: "IM 文本" };

export function reportMarkdown(r: P12Report): string {
  const lines: string[] = [];
  lines.push(`# P12 注入红队报告`, "");
  lines.push(`- 生成时间：${r.generated_at}`);
  lines.push(`- 观察时间：${r.observation.started_at} ～ ${r.observation.ended_at}`);
  lines.push(`- 环境：${r.environment.os}；Node ${r.environment.node}；${r.environment.engine}；受信 ripgrep：${r.environment.trusted_ripgrep ? "已配置" : "未配置（Glob / Grep 在本环境报错）"}`);
  lines.push(`- 版本：git ${r.environment.git_commit ?? "未知"}${r.environment.git_dirty ? "（有未提交改动）" : ""}`);
  lines.push(`- 用例目录：\`${r.case_dir}\``);
  lines.push(
    `- 分母：用例文件 ${r.totals.files}；无效 ${r.totals.invalid}；运行器未接入 ${r.totals.unsupported}；运行出错 ${r.totals.errored}；**已运行 ${r.totals.ran}，三类判定全部通过 ${r.totals.passed}，未通过 ${r.totals.failed}**`,
    "",
  );
  lines.push(`## 分层`, "", `| 层 | 已运行 | 通过 | 未通过 | 运行器未接入 |`, `|---|---|---|---|---|`);
  for (const [layer, v] of Object.entries(r.layers)) lines.push(`| ${LAYER_NAME[layer] ?? layer} | ${v.ran} | ${v.passed} | ${v.failed} | ${v.unsupported} |`);
  lines.push("", `## 逐例`, "", `| 编号 | 层 | 状态 | 零越界读写 | 零未经闸门出网 | 零未确认的跨边界动作 | 样本来源 |`, `|---|---|---|---|---|---|---|`);
  const mark = (ok: boolean | undefined) => (ok === undefined ? "—" : ok ? "通过" : "**未通过**");
  for (const c of r.results) {
    lines.push(`| ${c.id} | ${LAYER_NAME[c.layer] ?? c.layer} | ${c.status === "ran" ? c.runStatuses.join("、") : c.status === "unsupported" ? "运行器未接入" : c.status === "not_executed" ? "未执行（不计分母）" : "出错"} | ${mark(c.verdicts?.outOfBounds.ok)} | ${mark(c.verdicts?.ungatedEgress.ok)} | ${mark(c.verdicts?.unconfirmedCrossing.ok)} | ${c.source} |`);
  }
  const failures = r.results.filter((c) => c.status === "error" || (c.verdicts && !passed(c.verdicts)));
  if (failures.length > 0) {
    lines.push("", `## 失败与复现`, "");
    for (const c of failures) {
      lines.push(`### ${c.id}`, "");
      for (const [k, v] of Object.entries(c.verdicts ?? {})) for (const f of v.findings) lines.push(`- ${k}：${f}`);
      if (c.note) lines.push(`- 出错：${c.note.split("\n")[0]}`);
      lines.push(`- 复现：\`KWL_REDTEAM_CASES=${r.case_dir} KWL_REDTEAM_ONLY=${c.id} node --test packages/kernel/test/p12-redteam.test.ts\``, "");
    }
  }
  if (r.invalid.length > 0) {
    lines.push("", `## 无效用例（不进分母）`, "");
    for (const i of r.invalid) lines.push(`- \`${i.file}\`：${i.problems.join("；")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function writeReport(r: P12Report, dir: string): { json: string; md: string } {
  mkdirSync(dir, { recursive: true });
  const json = join(dir, "p12-report.json");
  const md = join(dir, "p12-report.md");
  writeFileSync(json, JSON.stringify(r, null, 2));
  writeFileSync(md, reportMarkdown(r));
  return { json, md };
}
