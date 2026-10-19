#!/usr/bin/env node
/**
 * 真实上游验收（第 13 批；评审 Z1 P0-1：“没有任何法律产出经过真实模型”）。
 *
 * 用真实的月之暗面开放平台跑四条核心工作流的完整链路：界面同一套内核 API → kap-host（Kimi Code）→ 出站闸门 → 云端 v0 网关
 * → 月之暗面；材料全部是**虚构的**验收用材料（不含任何真实客户信息）。
 *
 *   KWL_MOONSHOT_API_KEY=<测试组织的密钥> node scripts/upstream-acceptance.mjs [--out <目录>] [--only contract,research,drafting,analysis]
 *                                                                        [--search] [--keep-outputs] [--timeout-min 20]
 *   node scripts/upstream-acceptance.mjs --selftest   # 用 mock 上游自检脚本本身（不是验收）
 *
 * - 密钥只从环境变量读取、只交给本机起的网关进程，不写盘、不打印；报告里没有任何材料或成果的文字，只有状态、耗时、计数与 token 用量。
 * - 提问卡一律“跳过”（让 Agent 自行假设并在成果里写明）；确认卡缺省拒绝（不联网检索），`--search` 时放行改写后的一般性查询（逐次）。
 *   **非检索类确认卡一律拒绝**（打开网页、原样发图等）：若某条工作流确实需要这类操作，会表现为“未通过”，须人工复核是不是假阴性。
 * - `--keep-outputs`：把成果文件（已还原代号，虚构内容）另存到 <out>/outputs/ 供律师盲评；缺省不保存。
 * - 判定：每条工作流有最低验收线（任务成功、成果类型、风险卡数、引用核验结果等），且都要求“模型确有调用、网关无报错”；
 *   研究备忘录要求至少 1 条引用**核验通过**、0 条核验为错——只引用法规库以外（可能是编造的）法规或离线案号的备忘录不算通过，
 *   这两类另计“需律师核对”。全部通过退出码 0，否则 1；缺少密钥、或云端实际用的上游与模式不符（非自检却不是 moonshot），退出码 2。
 * - 工作目录（内核开发库、云端状态、开通码、席位令牌）在结束时删除（`--keep-work` 保留）；缺省报告目录 platform/output/ 已在 .gitignore。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
// --selftest：用 mock 上游跑同一套脚本，只证明脚本本身能跑通（报告标明“不是验收”）
const selftest = flag("--selftest");
if (selftest) delete process.env.KWL_MOONSHOT_API_KEY;
if (!selftest && !process.env.KWL_MOONSHOT_API_KEY) {
  console.error("缺少 KWL_MOONSHOT_API_KEY（月之暗面测试组织的密钥，只用环境变量给出）");
  process.exit(2);
}
const out = resolve(opt("--out", join(root, "output", `upstream-acceptance-${new Date().toISOString().replace(/[:.]/g, "-")}`)));
mkdirSync(out, { recursive: true });
const only = new Set(String(opt("--only", "contract,research,drafting,analysis")).split(","));
const timeoutMs = Number(opt("--timeout-min", "20")) * 60_000;
const work = mkdtempSync(join(tmpdir(), "kwl-acceptance-"));
const cloudDir = join(work, "cloud");
mkdirSync(cloudDir, { recursive: true });

// ── 云端 v0（真实上游）：密钥只给这个子进程 ──
const cloud = spawn(process.execPath, [join(root, "scripts/dev-cloud-v0.mjs")], {
  cwd: root,
  env: { ...process.env, KWL_CLOUD_DIR: cloudDir, ...(flag("--search") ? { KWL_MOONSHOT_SEARCH: "1" } : {}) },
  stdio: ["ignore", "pipe", "inherit"],
});
const exports = {};
let upstream = null;
let kernel = null;
let exitCode = 1;
const cleanup = async () => {
  await kernel?.close().catch(() => {});
  cloud.kill("SIGTERM");
  if (!flag("--keep-work")) rmSync(work, { recursive: true, force: true });
};
try {
  await new Promise((ok, fail) => {
    let buf = "";
    cloud.on("exit", (c) => fail(new Error(`云端 v0 退出（${c}）`)));
    cloud.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) {
        const m = /^export ([A-Z0-9_]+)=(.*)$/.exec(line);
        if (m) exports[m[1]] = m[2].replace(/^'|'$/g, "");
        const u = /上游：([A-Za-z0-9_-]+)/.exec(line);
        if (u) upstream = u[1];
      }
      if (/计量/.test(buf)) ok();
    });
  });
  // 云端实际用的上游与模式必须一致（复核 B13-O03：不只凭参数判定“真实上游”）
  if (upstream !== (selftest ? "mock" : "moonshot")) {
    console.error(`云端实际上游为 ${upstream ?? "未知"}，与${selftest ? "自检（应为 mock）" : "验收（应为 moonshot）"}不符，退出`);
    exitCode = 2;
    throw new Error("upstream_mismatch");
  }
  const kernelEnv = { ...process.env, ...exports, ZR_MODEL_PROVIDER: "upstream", ZR_KERNEL_TCP: "off" };
  delete kernelEnv.KWL_MOONSHOT_API_KEY;
  const { createKernel } = await import(join(root, "packages/kernel/src/index.ts"));
  kernel = await createKernel({ dataDir: join(work, "data"), firmSlug: "acceptance-firm", userSlug: "acceptance-lawyer", env: kernelEnv });
  const inv = (m, p = {}) => kernel.invoke(m, p);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const meterFile = join(cloudDir, "gateway-meter.jsonl");
  const meter = () => {
    if (!existsSync(meterFile)) return { calls: 0, input: 0, output: 0, cached: 0, errors: 0, truncated: 0 };
    const rows = readFileSync(meterFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const settle = rows.filter((r) => r.kind === "settle");
    return {
      calls: settle.length,
      input: settle.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
      output: settle.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
      cached: settle.reduce((a, r) => a + (r.cachedTokens ?? 0), 0),
      errors: rows.filter((r) => r.kind === "reject" || (r.status ?? 200) >= 400).length,
      // 输出被上限截断的调用（finish_reason=length；复核 B13-C01）
      truncated: settle.filter((r) => r.finishReason === "length").length,
    };
  };

  // ── 虚构验收材料（标明虚构；人名、公司名均为编造） ──
  const FICTION = "【验收用虚构材料，人物与公司均为编造】\n";
  const SCENARIOS = {
    contract: {
      title: "验收 · 星河科技受让云帆数据股权",
      stance: "受让方",
      client: "星河科技有限公司",
      counterparty: "云帆数据有限公司",
      skill: "contract-review",
      goal: "审查这份股权转让协议，我方为受让方：逐条列出主要风险并给出修改建议",
      materials: [
        [
          "股权转让协议.txt",
          FICTION +
            "股权转让协议\n转让方：云帆数据有限公司（甲方）\n受让方：星河科技有限公司（乙方）\n目标公司：云帆智算有限公司\n" +
            "第一条 甲方将其持有的目标公司 60% 股权转让给乙方，转让价款人民币 6,000 万元。\n" +
            "第二条 乙方应于本协议签署后 10 日内支付全部价款；甲方在收到价款后 90 日内办理工商变更登记。\n" +
            "第三条 甲方保证目标公司不存在未披露债务，但甲方对此不承担任何赔偿责任。\n" +
            "第四条 乙方逾期付款的，每日按应付未付款项的千分之五向甲方支付违约金；甲方逾期办理变更登记的，不承担违约责任。\n" +
            "第五条 过渡期内目标公司的经营损益由乙方承担。\n" +
            "第六条 甲方可在任何时候以书面通知解除本协议，已收价款不予退还。\n" +
            "第七条 因本协议发生的争议，由甲方所在地人民法院管辖。\n" +
            "第八条 本协议自甲方盖章之日起生效。\n",
        ],
      ],
    },
    research: {
      title: "验收 · 违约金调整研究",
      stance: "原告",
      client: "北辰贸易有限公司",
      counterparty: "南岭建材有限公司",
      skill: "legal-research-memo",
      goal: "研究问题：买卖合同约定的违约金明显过高时，人民法院如何调整？请写一份研究备忘录，注明所依据的法条",
      materials: [],
    },
    drafting: {
      title: "验收 · 北辰贸易催收货款",
      stance: "债权人",
      client: "北辰贸易有限公司",
      counterparty: "南岭建材有限公司",
      skill: "demand-letter",
      goal: "根据材料起草一份催款律师函，我方代理债权人北辰贸易有限公司",
      materials: [
        [
          "欠款事实.txt",
          FICTION +
            "2025 年 6 月 1 日，北辰贸易有限公司与南岭建材有限公司签订《钢材买卖合同》，约定货款 120 万元，收货后 30 日内付清。\n" +
            "北辰贸易于 2025 年 7 月 5 日交付全部货物，南岭建材出具收货单。截至 2026 年 9 月 30 日，南岭建材仅支付 40 万元，尚欠 80 万元。\n" +
            "北辰贸易多次电话与微信催告，对方以资金紧张为由拖延。合同约定逾期付款按日万分之五支付违约金。\n",
        ],
      ],
    },
    analysis: {
      title: "验收 · 北辰诉南岭买卖合同纠纷",
      stance: "原告",
      client: "北辰贸易有限公司",
      counterparty: "南岭建材有限公司",
      skill: "issue-evidence-matrix",
      goal: "整理本案争点与证据，形成争点—证据矩阵，并指出证据缺口",
      materials: [
        ["起诉要点.txt", FICTION + "原告主张：被告欠付货款 80 万元及逾期违约金；被告可能抗辩货物质量不合格、已口头约定延期付款。\n"],
        ["证据清单.txt", FICTION + "1. 《钢材买卖合同》（原件）\n2. 收货单（被告盖章）\n3. 银行回单两张（合计 40 万元）\n4. 微信催款记录截图 12 张\n5. 质量检验报告（无，被告未提出书面异议）\n"],
        ["微信记录摘录.txt", FICTION + "2026-03-02 原告：货款何时结清？\n2026-03-02 被告：最近资金紧，年底前一定付。\n2026-08-15 原告：已超期一年，请尽快付款。\n2026-08-16 被告：货有些问题，我们再看看。\n"],
      ],
    },
  };

  const results = [];
  for (const [key, sc] of Object.entries(SCENARIOS)) {
    if (!only.has(key)) continue;
    const t0 = Date.now();
    const m0 = meter();
    const r = { scenario: key, skill: sc.skill, status: null, terminal_reason: null, duration_s: 0, model: {}, tool_calls: 0, questions_skipped: 0, approvals: { approved: 0, rejected: 0 }, artifacts: [], checks: {}, pass: false, problems: [] };
    try {
      const { matter } = await inv("matters.create", { title: sc.title, stance: sc.stance, client_name: sc.client, counterparty: sc.counterparty, consent_status: "not_required" });
      const docs = [];
      for (const [name, text] of sc.materials) docs.push((await inv("materials.import", { matter_id: matter.matter_id, filename: name, data_base64: Buffer.from(text).toString("base64"), mime: "text/plain" })).document_version_id);
      const est = await inv("runs.estimate", { matter_id: matter.matter_id, scenario: "a1.agent_task", document_version_ids: docs, goal: sc.goal, skill: sc.skill });
      if (est.data_where?.start_blocked) throw new Error(`发起被拦：${est.data_where.block_kind ?? "unknown"}`);
      const run = await inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `acc-${key}-${Date.now()}`, goal: sc.goal, skill: sc.skill, plan_first: false, mode: "default" });
      let st = null;
      for (;;) {
        st = (await inv("runs.get", { run_id: run.run_id })).run;
        if (["succeeded", "partial", "failed", "cancelled", "timed_out", "expired", "reconciling"].includes(st.status)) break;
        if (Date.now() - t0 > timeoutMs) {
          r.problems.push("超时");
          await inv("runs.cancel", { run_id: run.run_id, expected_version: st.status_version }).catch(() => {});
          break;
        }
        if (st.status === "waiting_input" || st.status === "waiting_approval") {
          const it = await inv("runs.interactions", { run_id: run.run_id });
          for (const q of it.questions ?? []) {
            await inv("runs.answer", { run_id: run.run_id, question_id: q.question_id, answers: Object.fromEntries(q.questions.map((x) => [x.id, { kind: "skipped" }])) }).catch((e) => r.problems.push(`作答失败：${e.code ?? e.message}`));
            r.questions_skipped += 1;
          }
          for (const c of it.approvals ?? []) {
            const allow = flag("--search") && c.kind === "search";
            await inv("runs.approve", { run_id: run.run_id, approval_id: c.approval_id, object_hash: c.object_hash, nonce: c.nonce, decision: allow ? "approve" : "reject", ...(allow ? { scope: "once", variant: "generalized" } : { feedback: "验收脚本：本次不联网，请仅依据材料与本机法规库完成" }) }).catch((e) => r.problems.push(`确认失败：${e.code ?? e.message}`));
            r.approvals[allow ? "approved" : "rejected"] += 1;
          }
        }
        await sleep(2_000);
      }
      const fin = await inv("runs.get", { run_id: run.run_id });
      r.status = fin.run.status;
      r.terminal_reason = fin.run.terminal_reason ?? null;
      const evs = (await inv("runs.events", { run_id: run.run_id, limit: 2000 })).events ?? [];
      r.tool_calls = evs.filter((e) => e.type === "agent.tool_started").length;
      r.event_types = Object.fromEntries([...new Set(evs.map((e) => e.type))].map((t) => [t, evs.filter((e) => e.type === t).length]));
      for (const a of fin.artifacts ?? []) {
        const comp = await inv("review.completeness", { artifact_version_id: a.artifact_version_id }).catch(() => null);
        const ac = comp?.completeness?.artifact_citations;
        r.artifacts.push({ filename_ext: String(a.filename).split(".").pop(), kind: a.kind, bytes: a.size ?? null, citations: ac ? { total: ac.total, verified: ac.verified, outside_registry: ac.outside_registry, wrong: ac.wrong, case_offline: ac.unverified_offline } : null });
        if (flag("--keep-outputs")) {
          const d = await inv("artifacts.download", { artifact_version_id: a.artifact_version_id }).catch(() => null);
          if (d?.data_base64) {
            mkdirSync(join(out, "outputs", key), { recursive: true });
            writeFileSync(join(out, "outputs", key, String(a.filename).replace(/[\\/:*?"<>|]/g, "_")), Buffer.from(d.data_base64, "base64"));
          }
        }
      }
      // 各工作流的最低验收线
      const ok = r.status === "succeeded" && r.artifacts.length > 0;
      if (key === "contract") {
        const cards = (await inv("riskcards.list", { matter_id: matter.matter_id, run_id: run.run_id })).cards ?? [];
        r.checks.risk_cards = cards.length;
        for (const c of cards) await inv("riskcards.decide", { matter_id: matter.matter_id, card_id: c.card_id, decision: "accepted" }).catch(() => {});
        const red = cards.length ? await inv("riskcards.redline", { matter_id: matter.matter_id, document_version_id: docs[0], run_id: run.run_id }).catch((e) => ({ status: `error:${e.code}` })) : { status: "no_cards" };
        r.checks.redline = red.status;
        r.pass = ok && cards.length >= 3 && red.status === "applied";
      } else if (key === "research") {
        const sum = (f) => r.artifacts.reduce((n, a) => n + (a.citations?.[f] ?? 0), 0);
        r.checks.citations_total = sum("total");
        r.checks.citations_verified = sum("verified");
        r.checks.citations_wrong = sum("wrong");
        // 法规库以外的法规（可能是编造的）与离线案号：不算错，但也不算核验通过，另计“需律师核对”
        r.checks.citations_needs_review = sum("outside_registry") + sum("case_offline");
        r.pass = ok && r.checks.citations_verified >= 1 && r.checks.citations_wrong === 0;
      } else if (key === "drafting") {
        // 律师函方法的交付件：函件草稿 .docx（另有依据与核对 .xlsx）
        r.pass = ok && r.artifacts.some((a) => a.filename_ext === "docx");
      } else {
        // 争点—证据矩阵方法的交付件：.xlsx
        r.pass = ok && r.artifacts.some((a) => a.filename_ext === "xlsx");
      }
    } catch (e) {
      r.problems.push(`${e.code ?? "error"}：${String(e.message).slice(0, 200)}`);
    }
    const m1 = meter();
    r.model = { calls: m1.calls - m0.calls, input_tokens: m1.input - m0.input, output_tokens: m1.output - m0.output, cached_tokens: m1.cached - m0.cached, gateway_errors: m1.errors - m0.errors, truncated: m1.truncated - m0.truncated };
    // 总闸：模型确有调用、网关无报错（复核 B13-O03）
    if (r.model.calls === 0) r.problems.push("没有模型调用");
    if (r.model.gateway_errors > 0) r.problems.push(`网关报错 ${r.model.gateway_errors} 次`);
    r.pass = r.pass && r.model.calls > 0 && r.model.gateway_errors === 0;
    r.duration_s = Math.round((Date.now() - t0) / 1000);
    results.push(r);
    console.log(`[验收] ${key}：${r.pass ? "通过" : "未通过"}（${r.status ?? "-"}，${r.duration_s} 秒，模型 ${r.model.calls} 次）`);
  }

  const st = await inv("kernel.status").catch(() => ({}));
  const report = { at: new Date().toISOString(), selftest, upstream, search: flag("--search"), engine: "kap-host", kernel_version: st.version ?? null, lawdb: (await inv("lawdb.status").catch(() => ({}))).coverage ?? null, results, all_pass: results.length > 0 && results.every((r) => r.pass) };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  const md = [
    selftest ? `# 验收脚本自检（mock 上游，**不是验收结果**；${report.at}）` : `# 真实上游验收报告（${report.at}）`,
    "",
    `上游：${report.upstream} · 联网检索：${report.search ? "放行改写后的查询" : "不联网"} · 法规库覆盖：${report.lawdb?.level ?? "?"}（${report.lawdb?.laws ?? "?"} 部） · 结论：**${report.all_pass ? "全部通过" : "有未通过项"}**`,
    "",
    "| 工作流 | 方法 | 结论 | 状态 | 耗时（秒） | 模型调用 | 输出截断 | 输入/输出 token | 工具事件 | 成果 | 附加检查 | 问题 |",
    "|---|---|---|---|---:|---:|---:|---|---:|---|---|---|",
    ...results.map((r) => `| ${r.scenario} | ${r.skill} | ${r.pass ? "✓" : "✗"} | ${r.status ?? "-"}${r.terminal_reason ? `（${r.terminal_reason}）` : ""} | ${r.duration_s} | ${r.model.calls} | ${r.model.truncated ?? 0} | ${r.model.input_tokens}/${r.model.output_tokens} | ${r.tool_calls} | ${r.artifacts.map((a) => a.filename_ext).join("、") || "无"} | ${JSON.stringify(r.checks)} | ${r.problems.join("；") || "—"} |`),
    "",
    "报告只含状态与计数；材料为虚构验收材料；成果文字未写入报告（--keep-outputs 时另存于 outputs/ 供律师盲评）。",
  ].join("\n");
  writeFileSync(join(out, "report.md"), md + "\n");
  console.log(`[验收] 报告：${join(out, "report.md")}`);
  exitCode = report.all_pass ? 0 : 1;
} catch (e) {
  if (String(e?.message) !== "upstream_mismatch") console.error(`[验收] 中止：${String(e?.message ?? e).slice(0, 300)}`);
} finally {
  await cleanup();
}
process.exit(exitCode);
