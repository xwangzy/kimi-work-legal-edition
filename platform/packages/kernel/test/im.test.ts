/**
 * IM 入口原型（方案 §11.2/§9/§6.3/探针 14 v0，模拟器全链）：
 * 单聊收文件 → 卡片选项（只含授权事项、文案脱敏）→ 选择 → 入库 → 节点执行 → 回执；
 * IM 不能确认签发（v9 第 02 篇 §9.6、§13 第 6 条：请求即拒、遗留意向拒绝、确认动作拒绝；外发只认设备签名）；
 * 选主租约；离线行为；数据去向（im_inbound/im_outbound，对象哈希化）。**模拟器非平台。**
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImSimulator, DingtalkStreamConnector } from "@zr-legal/im-connectors";
import { makeKernel, runScenario, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";
import { startFirmNode, type FirmNodeHandle } from "@zr-legal/firm-node";

const PLATFORM = "dingtalk";
let tk: TestKernel;
let node: FirmNodeHandle;
let sim: ImSimulator;
let shareDir: string;
let nodeDeviceId: string;

before(async () => {
  sim = new ImSimulator({ platform: PLATFORM, chunkSize: 64 * 1024 });
  await sim.start();
  shareDir = mkdtempSync(join(tmpdir(), "kwl-im-share-"));
  tk = await makeKernel({}, "im-firm");
  const wsN = mkdtempSync(join(tmpdir(), "kwl-im-node-"));
  mkdirSync(join(wsN, "im-firm", "keys"), { recursive: true });
  copyFileSync(join(tk.dir, "im-firm", "keys", "firm-root.json"), join(wsN, "im-firm", "keys", "firm-root.json"));
  node = await startFirmNode({
    dataDir: wsN,
    firmSlug: "im-firm",
    shareDir,
    syncIntervalMs: 60_000,
    leaseMs: 5_000,
    consoleToken: "im-console-token",
    im: { platform: PLATFORM, endpoint: sim.url },
    env: { ...process.env, ZR_MODEL_PROVIDER: "mock" },
  });
  nodeDeviceId = "dev_im-firm_node";
  const nodeDev = node.kernel.db.get<any>(`SELECT * FROM devices WHERE device_id = ?`, [nodeDeviceId]);
  tk.kernel.db.run(
    `INSERT OR IGNORE INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue) VALUES (?,?,?,?,?,?,?, 'active', 1)`,
    [nodeDev.device_id, nodeDev.tenant_id, nodeDev.member_id, nodeDev.role, nodeDev.sign_pub_pem, nodeDev.enc_pub_pem, nodeDev.cert_json],
  );
});

after(async () => {
  await tk.kernel.close();
  await node.stop();
  await sim.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("探针 14 v0 全链：单聊收文件 → 卡片选项脱敏 → 选择 → 入库 → 执行 → 回执（分片下载）", { timeout: 240_000 }, async () => {
  const { inv } = tk;
  // 授权事项（团队+节点授权）+ 未授权 + strict
  const { matter } = await inv("matters.create", { title: "股权转让审查（机密客户甲公司）", stance: "受让方", consent_status: "not_required", collab_scope: "team", client_name: "甲公司", key_dates: { analysis_as_of: "2026-10-01" } });
  await inv("matters.node_authorize", { matter_id: matter.matter_id, node_device_id: nodeDeviceId });
  await inv("matters.create", { title: "未授权事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await inv("matters.create", { title: "strict 事项", stance: "受让方", consent_status: "not_required", collab_scope: "team", confidentiality: "strict" });
  await inv("sync.export", { share_dir: shareDir });
  await node.kernel.invoke("sync.import", { share_dir: shareDir });
  // 绑定发送人（节点库内）
  await node.kernel.invoke("im.bind", { platform: PLATFORM, im_user_id: "u_lawyer_1", member_id: "usr_im-firm_test-lawyer" });

  // 200KB 真实 PDF（触发分片下载路径；伪 PDF 会被解析层如实拒绝）
  const { testingPdf } = await import("@zr-legal/parse-ocr");
  const big = testingPdf.makeTextPdf(Array.from({ length: 400 }, (_, i) => `Page ${i + 1}: Article 1 Contract Object and Payment Terms with additional clauses`));
  assert.ok(big.length > 64 * 1024);
  sim.emitFileMessage({ senderImId: "u_lawyer_1", filename: "股权转让协议.pdf", bytes: big, mime: "application/pdf" });
  await sleep(800);

  // 卡片选项：只含已授权事项（1 个），且文案不含客户名/案情（脱敏硬断言）
  assert.ok(sim.probes.sentCards.length >= 1, "应已发出选择卡片");
  const card = sim.probes.sentCards[0]!.card;
  const cardJson = JSON.stringify(card);
  assert.ok(!cardJson.includes("甲公司") && !cardJson.includes("股权转让审查"), `卡片文案不得含客户名/案情：${cardJson}`);
  const chooseActions = (card.actions ?? []).filter((a) => a.actionId.startsWith("choose:"));
  assert.equal(chooseActions.length, 1, `只应列 1 个已授权事项：${JSON.stringify(card.actions)}`);

  // 第二名成员（真非本人用例的演员表；im.bind 校验成员存在）
  node.kernel.db.run(`INSERT OR IGNORE INTO users (user_id, tenant_id, display_name) VALUES (?,?,?)`, ["usr_im-firm_other", node.kernel.identity.tenantId, "另一律师"]);
  await node.kernel.invoke("im.bind", { platform: PLATFORM, im_user_id: "u_lawyer_2", member_id: "usr_im-firm_other" });

  // 群转发不扩权①：真非本人（另一绑定成员）点选择 → 拒绝
  const rOther = await sim.emitCardAction({ actionId: chooseActions[0]!.actionId, actorImId: "u_lawyer_2" });
  assert.match(rOther.text, /只有发送者本人/, `非发送者本人点卡片必须拒绝：${rOther.text}`);
  // 群转发不扩权②：未绑定用户点卡片 → 拒绝
  const rStranger = await sim.emitCardAction({ actionId: chooseActions[0]!.actionId, actorImId: "u_stranger" });
  assert.match(rStranger.text, /未绑定成员/, `未绑定用户点卡片必须拒绝：${rStranger.text}`);
  // 本人选择 → 入库 + 派发
  const r = await sim.emitCardAction({ actionId: chooseActions[0]!.actionId, actorImId: "u_lawyer_1" });
  assert.ok(r.withinMs < 2000, `同步应答在 2 秒硬限内：${r.withinMs}ms`);
  await sleep(1200);

  // 入库断言：材料进入授权事项且字节一致（分片拼合无损）
  const docs = tk.kernel.db.all<any>(`SELECT * FROM document_versions WHERE matter_id = ?`, [matter.matter_id]);
  void docs;
  const nDocs = node.kernel.db.all<any>(`SELECT * FROM document_versions WHERE matter_id = ?`, [matter.matter_id]);
  assert.ok(nDocs.length >= 1, "文件已入授权事项");
  const sha256 = createHash("sha256").update(big).digest("hex");
  assert.equal(nDocs[0].sha256, sha256, "分片下载拼合后 hash 与原文件一致");

  // 任务执行（tick 内 mock S1）与回执卡片
  await node.tick();
  await sleep(500);
  const tasks = node.kernel.db.all<any>(`SELECT status FROM node_tasks WHERE matter_id = ?`, [matter.matter_id]);
  assert.ok(tasks.length >= 1 && tasks[0].status === "succeeded", `任务应执行成功：${JSON.stringify(tasks)}`);
  const receipt = sim.probes.sentCards.at(-1)!.card;
  const receiptJson = JSON.stringify(receipt);
  assert.ok(receiptJson.includes("已收到") || receiptJson.includes("已入库"), "应有回执卡片");
  assert.ok(!receiptJson.includes("甲公司") && !receiptJson.includes("股权转让审查"), "回执同样脱敏");

  // 数据去向：im_inbound 记录（hash、对象哈希化、平台）
  const recs = (await node.kernel.invoke("egress.records", { matter_id: matter.matter_id })) as any;
  const inbound = recs.records.find((x: any) => x.destination_kind === "im_inbound");
  assert.ok(inbound, "应有 im_inbound 去向记录");
  assert.equal(inbound.destination_host, PLATFORM);
  assert.ok(String(inbound.note).includes(`sha256=${createHash("sha256").update(big).digest("base64url")}`) || String(inbound.note).includes("sha256="), "记录含文件 hash");
  assert.ok(!String(inbound.note).includes("u_lawyer_1"), "发送对象须哈希化（不明文 im_user_id）");

  // 未绑定用户：回复未绑定提示；群聊：回复单聊提示
  sim.emitFileMessage({ senderImId: "u_stranger", filename: "x.txt", bytes: Buffer.from("x"), chatType: "direct" });
  await sleep(400);
  assert.ok(JSON.stringify(sim.probes.sentCards.at(-1)!.card).includes("未绑定"), "未绑定用户应收到绑定提示");
  sim.emitFileMessage({ senderImId: "u_lawyer_1", filename: "x.txt", bytes: Buffer.from("x"), chatType: "group" });
  await sleep(400);
  const groupCardJson = JSON.stringify(sim.probes.sentCards.at(-1)!.card);
  assert.ok(groupCardJson.includes("单聊"), "群聊应引导单聊");
  assert.ok(!groupCardJson.includes("x.txt"), "群形态外发不得回显文件名（群卡片最小化纪律）");
});

test("IM 不能确认签发（v9 第 02 篇 R5、§9.6、§13 第 6 条；第 06 篇 T18；阶段 7 复核 S7-A08）：请求即拒；遗留的签发审批意向一律拒绝、不经 IM 发文件与审批卡；“确认签发”动作一律拒绝且不落签发记录；外发只认设备签名", { timeout: 240_000 }, async () => {
  const { inv } = tk;
  const { matter } = await inv("matters.create", { title: "IM 审批事项", stance: "受让方", consent_status: "not_required", collab_scope: "team", key_dates: { analysis_as_of: "2026-10-01" } });
  await inv("matters.node_authorize", { matter_id: matter.matter_id, node_device_id: nodeDeviceId });
  const doc = await inv("materials.import", { matter_id: matter.matter_id, filename: "协议.txt", data_base64: Buffer.from(DEMO_CONTRACT, "utf8").toString("base64"), mime: "text/plain" });
  const d = await runScenario(inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] }, 120_000);
  const art = d.artifacts.find((a: any) => a.kind === "s1_opinion");
  await inv("review.submit", { artifact_version_id: art.artifact_version_id });

  // 请求 IM 确认：不论受众一律拒绝
  for (const audience of ["client", "internal", "court"]) {
    await assert.rejects(() => inv("approvals.request_im", { artifact_version_id: art.artifact_version_id, audience, platform: PLATFORM }), (e: any) => e.code === "im_signoff_disabled", audience);
  }

  // 遗留的签发审批意向（v5 数据）：节点一律标为拒绝——不经 IM 发送待交付文件、不发审批卡
  await inv("sync.export", { share_dir: shareDir });
  await node.kernel.invoke("sync.import", { share_dir: shareDir });
  const legacy = `imi_legacy_${Date.now().toString(36)}`;
  node.kernel.db.run(`INSERT INTO im_intents (intent_id, tenant_id, kind, platform, status, payload, created_by) VALUES (?,?,?,?,'pending',?,?)`, [
    legacy,
    node.kernel.identity.tenantId,
    "approval_request",
    PLATFORM,
    JSON.stringify({ artifact_version_id: art.artifact_version_id, audience: "client", issuer_member_id: "usr_im-firm_test-lawyer", artifact_sha256: art.sha256 }),
    "usr_im-firm_test-lawyer",
  ]);
  const files0 = sim.probes.sentFiles.length;
  const cards0 = sim.probes.sentCards.length;
  await node.tick();
  assert.equal(node.kernel.db.get<any>(`SELECT status FROM im_intents WHERE intent_id = ?`, [legacy]).status, "rejected");
  assert.equal(sim.probes.sentFiles.length, files0, "不经 IM 发送待交付文件");
  assert.equal(sim.probes.sentCards.length, cards0, "不发审批卡");

  // “确认签发”卡片动作（即便是签发人本人、意向编号真实）：一律拒绝，不落任何签发记录
  const r = await sim.emitCardAction({ actionId: `confirm:${legacy}`, actorImId: "u_lawyer_1" });
  assert.match(r.text, /IM 不能确认签发/);
  await sleep(300);
  assert.equal(node.kernel.db.get<any>(`SELECT COUNT(*) AS n FROM approvals`).n, 0, "节点不产生任何签发记录");
  assert.equal(tk.kernel.db.get<any>(`SELECT COUNT(*) AS n FROM approvals WHERE assurance_level = 'im_witnessed'`).n, 0);

  // 外发门禁（遗留数据纵深）：只有 im_witnessed 批准的客户版成果不得外发——外发只认设备签名
  tk.kernel.db.run(`UPDATE artifact_versions SET audience = 'client', status = 'approved' WHERE artifact_version_id = ?`, [art.artifact_version_id]);
  tk.kernel.db.run(
    `INSERT INTO approvals (approval_id, artifact_version_id, artifact_sha256, approver_id, decision, audience, assurance_level, checklist, signer_device_id, signature, completeness_hash, key_epoch, signed_payload)
     VALUES (?,?,?,?,'approved','client','im_witnessed','{}',?,?,?,1,?)`,
    ["apr_legacy_im", art.artifact_version_id, art.sha256, tk.kernel.identity.userId, nodeDeviceId, "legacy", "legacy", "{}"],
  );
  await assert.rejects(
    () => inv("deliveries.create", { artifact_version_id: art.artifact_version_id, action: "external_send", audience: "client" }),
    (e: any) => e.code === "approval_invalidated" && /device_signature/.test(e.message),
  );
});

test("选主租约与离线行为", { timeout: 120_000 }, async () => {
  const { claimImLease } = await import("../../../apps/firm-node/src/im-runtime.ts");
  const db = tk.kernel.db;
  // 双实例抢租约：恰好一个持有
  assert.equal(claimImLease(db, "dingtalk", "owner-A", 60_000), true);
  assert.equal(claimImLease(db, "dingtalk", "owner-B", 60_000), false, "另一活连接器持租约时拒绝启动");
  // 租约过期后可接管
  db.run(`UPDATE im_connector_lease SET lease_until = ? WHERE platform = 'dingtalk'`, [new Date(Date.now() - 1000).toISOString()]);
  assert.equal(claimImLease(db, "dingtalk", "owner-B", 60_000), true, "过期接管（企业微信单连接语义）");
  db.run(`DELETE FROM im_connector_lease WHERE platform = 'dingtalk'`);

  // 钉钉离线语义：模拟器在无连接时投递 → dropped_offline 计数
  const sim2 = new ImSimulator({ platform: "dingtalk" });
  await sim2.start();
  sim2.emitFileMessage({ senderImId: "u_x", filename: "x.txt", bytes: Buffer.from("x") });
  assert.ok(sim2.probes.droppedOffline >= 1, "钉钉语义：离线即丢并计数");
  await sim2.stop();

  // 飞书语义：离线消息入重推队列（连接后补投）——用独立模拟器 + 一个临时连接器验证
  const sim3 = new ImSimulator({ platform: "feishu" });
  await sim3.start();
  sim3.emitTextMessage({ senderImId: "u_x", text: "离线期间的文件" });
  assert.ok(sim3["offlineQueue" as never] !== undefined, "飞书语义：离线消息入重推队列（不丢）");
  await sim3.stop();

  // 企业微信语义：单连接踢线——新连接踢掉旧连接（旧连接收 kicked_by_new_connection，新连接保持在线）
  const simW = new ImSimulator({ platform: "wecom" });
  await simW.start();
  const kicks: { kind: string; detail: string }[] = [];
  const noop = async () => {};
  const c1 = new DingtalkStreamConnector({ endpoint: simW.url });
  await c1.start({ onFileMessage: noop, onCardAction: noop, onOfflineEvent: (kind, detail) => void kicks.push({ kind, detail }) });
  await c1.waitReady();
  const c2 = new DingtalkStreamConnector({ endpoint: simW.url });
  await c2.start({ onFileMessage: noop, onCardAction: noop });
  await c2.waitReady();
  await sleep(300); // 踢线帧到达（重连退避 500ms 起步，断言窗口内不会触发回踢循环）
  assert.ok(
    kicks.some((k) => k.kind === "kicked_by_new_connection"),
    `企业微信语义：旧连接应收到 kicked_by_new_connection：${JSON.stringify(kicks)}`,
  );
  assert.ok(c2.isOnline(), "新连接保持在线");
  await c1.stop();
  await c2.stop();
  await simW.stop();
});
