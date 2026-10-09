/**
 * 共享文件夹同步（方案 §7.1/§7.2）：双工作区（同一律所根、两台设备）经共享目录互同步。
 * 覆盖：团队事项/材料/run/成果/签发到达；段只追加不改写；并发双版本 + conflict.detected；
 * 个人事项跳过；无密钥事项跳过；.tmp/冲突副本命名告警；撤权设备旧纪元段拒收；各自签名链独立成立。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "../src/index.ts";
import { makeKernel, runScenario, DEMO_CONTRACT, type TestKernel } from "./helpers.ts";

let kA: TestKernel;
let kB: { kernel: Kernel; dir: string; inv: (m: string, p?: any) => Promise<any> };
let shareDir: string;
const kernels: Kernel[] = [];

before(async () => {
  shareDir = mkdtempSync(join(tmpdir(), "kwl-share-"));
  kA = await makeKernel({}, "sync-firm");
  kernels.push(kA.kernel);
  // 同一律所根引导第二台「电脑」：先放 firm-root.json，B 复用同一根（设备证书链一致）
  const wsB = mkdtempSync(join(tmpdir(), "kwl-wsB-"));
  mkdirSync(join(wsB, "sync-firm", "keys"), { recursive: true });
  copyFileSync(join(kA.dir, "sync-firm", "keys", "firm-root.json"), join(wsB, "sync-firm", "keys", "firm-root.json"));
  const { createKernel } = await import("../src/index.ts");
  const kernelB = await createKernel({
    dataDir: wsB,
    firmSlug: "sync-firm",
    userSlug: "bob",
    env: { ...process.env, ZR_MODEL_PROVIDER: "mock" },
  });
  kB = { kernel: kernelB, dir: wsB, inv: (m, p) => kernelB.invoke(m, p) };
  kernels.push(kernelB);

  // A 登记 B 的设备（跨机器设备加入流程在 G1；v0 测试直接登记证书）
  const bobDev = kB.kernel.db.get<any>(`SELECT * FROM devices WHERE device_id = 'dev_sync-firm_bob'`);
  kA.kernel.db.run(
    `INSERT OR IGNORE INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue) VALUES (?,?,?,?,?,?,?, 'active', 1)`,
    [bobDev.device_id, bobDev.tenant_id, bobDev.member_id, bobDev.role, bobDev.sign_pub_pem, bobDev.enc_pub_pem, bobDev.cert_json],
  );
});

after(async () => {
  for (const k of kernels) {
    try {
      await k.close();
    } catch {
      // 已关闭
    }
  }
});

test("同步全链路：导出/摄取/冲突/跳过/告警/撤权拒收", { timeout: 300_000 }, async () => {
  const bobUserId = "usr_sync-firm_bob";

  // 1. A 建团队事项 + 加 B 为成员 + 导入材料（此时 B 无任何内容）
  const { matter } = await kA.inv("matters.create", { title: "同步团队事项", stance: "受让方", consent_status: "not_required", collab_scope: "team", key_dates: { analysis_as_of: "2026-10-01" } });
  await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: bobUserId });
  const doc = await kA.inv("materials.import", { matter_id: matter.matter_id, filename: "协议.txt", data_base64: Buffer.from(DEMO_CONTRACT, "utf8").toString("base64"), mime: "text/plain" });

  // 个人事项（应被跳过）
  const personal = await kA.inv("matters.create", { title: "个人事项", stance: "受让方", consent_status: "not_required", collab_scope: "personal" });
  // 无 B 密钥的团队事项（B 非成员）
  const noKey = await kA.inv("matters.create", { title: "无 B 密钥事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });

  // 2. A 首次导出（事项+成员+密钥+材料）
  const ex1 = await kA.inv("sync.export", { share_dir: shareDir });
  assert.ok(ex1.segments.length >= 2, `应产出段（团队事项×2）：${ex1.segments.length}`);
  assert.ok(ex1.skippedPersonal.includes(personal.matter.matter_id), "个人事项跳过");
  assert.ok(ex1.segments.every((p: string) => existsSync(p)), "段文件存在");

  // 半成品与冲突副本命名 → 告警
  const segDevDir = join(shareDir, kA.kernel.identity.tenantId, "segments", "dev_sync-firm_test-lawyer");
  writeFileSync(join(segDevDir, ".tmp-unfinished.seg"), "{");
  writeFileSync(join(segDevDir, "abc.sync-conflict-2026.seg"), "{}");

  // 3. B 摄取：获得事项/成员/材料/密钥；无密钥事项跳过；告警分类正确
  const im1 = await kB.inv("sync.import", { share_dir: shareDir });
  assert.ok(im1.segmentsApplied >= 1, `B 应应用段：${JSON.stringify(im1)}`);
  assert.ok(im1.skippedNoKey.includes(noKey.matter.matter_id), "无 B 密钥事项跳过");
  assert.ok(im1.warnings.tmpFiles.length === 1 && im1.warnings.conflictCopies.length === 1, JSON.stringify(im1.warnings));
  const bMatter = await kB.inv("matters.get", { matter_id: matter.matter_id });
  assert.equal(bMatter.matter.matter_id, matter.matter_id, "B 已摄取事项");
  assert.ok(bMatter.documents.length === 1, "B 已摄取材料行");
  // B 能解密读取同步来的密文块
  const bDocRow = kB.kernel.db.get<any>(`SELECT storage_uri FROM document_versions WHERE matter_id = ?`, [matter.matter_id]);
  assert.match(kB.kernel.blobs.read(bDocRow.storage_uri).toString("utf8"), /保密义务/, "B 可读同步材料内容");

  // 4. 双机并发产出同一版本（A、B 各自跑 S1，均得 v1）→ B 导出 → A 摄取出冲突
  const dA = await runScenario(kA.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [doc.document_version_id] }, 120_000);
  assert.equal(dA.run.status, "succeeded");
  const bDocs = await kB.inv("matters.get", { matter_id: matter.matter_id });
  const dB = await runScenario(kB.inv, matter.matter_id, "s1.contract_review", { document_version_ids: [bDocs.documents[0].document_version_id] }, 120_000);
  assert.equal(dB.run.status, "succeeded");

  await kA.inv("sync.export", { share_dir: shareDir });
  await kB.inv("sync.export", { share_dir: shareDir });
  const imA = await kA.inv("sync.import", { share_dir: shareDir });
  const imB2 = await kB.inv("sync.import", { share_dir: shareDir });

  assert.ok(imA.conflicts.length >= 1, `A 摄取应检出并发冲突：${JSON.stringify(imA.conflicts)}`);
  assert.ok(imA.conflicts.some((c: any) => c.kind === "concurrent_artifact_versions"));
  // 双版本都保留（本地 v1 + 入段 max+1）
  const arts = kA.kernel.db.all(`SELECT artifact_version_id, kind, version FROM artifact_versions WHERE matter_id = ? AND kind = 's1_opinion' ORDER BY version`, [matter.matter_id]) as any[];
  assert.deepEqual(arts.map((a) => a.version), [1, 2], "并发两版本都保留");
  assert.ok(kA.kernel.db.get(`SELECT 1 AS x FROM sync_conflicts WHERE matter_id = ? AND resolved = 0`, [matter.matter_id]), "冲突旗标落库");
  assert.ok(kA.kernel.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'conflict.detected' AND object_id = ?`, [matter.matter_id]), "conflict.detected 审计事件");
  // A 读到 B 产出的成果（经同步块 + A 的密钥）
  const bArtRow = kA.kernel.db.get<any>(`SELECT storage_uri FROM artifact_versions WHERE artifact_version_id = ?`, [JSON.parse(imA.conflicts[0].detail).artifact_version_id]);
  assert.ok(bArtRow, "B 的成果行已入 A 库");
  assert.ok(kA.kernel.blobs.read(bArtRow.storage_uri).length > 50, "A 可读 B 的同步成果");

  // B 也摄取到 A 的 run/成果/签发链各自独立：两台设备各自 verifyChain 成立
  const vcA = await kA.inv("audit.verifyChain");
  const vcB = await kB.inv("audit.verifyChain");
  assert.equal(vcA.ok, true, `A 链独立成立：${JSON.stringify(vcA.failures)}`);
  assert.equal(vcB.ok, true, `B 链独立成立：${JSON.stringify(vcB.failures)}`);
  void imB2;

  // sync.status 水位与旗标
  const st = await kA.inv("sync.status", { share_dir: shareDir });
  const item = st.matters.find((x: any) => x.matter_id === matter.matter_id);
  assert.ok(item.last_export_lamport >= 1 && item.unresolved_conflicts >= 1, JSON.stringify(item));
});

test("段只追加不改写：同一设备目录下段文件只增不改", async () => {
  const before1 = kA.inv("sync.export", { share_dir: shareDir });
  const dir = join(shareDir, kA.kernel.identity.tenantId, "segments", "dev_sync-firm_test-lawyer");
  const names1 = existsSync(dir) ? (await import("node:fs")).readdirSync(dir).filter((n: string) => n.endsWith(".seg")) : [];
  await before1;
  const names2 = (await import("node:fs")).readdirSync(dir).filter((n: string) => n.endsWith(".seg"));
  assert.ok(names2.length >= names1.length, "段文件只增（追加写自己的段）");
});

test("阻断-1 回归：删除→回灌→再轮换，被移出成员不得获得新纪元包裹", { timeout: 180_000 }, async () => {
  const bobUserId = "usr_sync-firm_bob";
  // A 建事项加 bob → 同步到 B（B 获得有效成员行）
  const { matter } = await kA.inv("matters.create", { title: "墓碑回归事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: bobUserId });
  await kA.inv("sync.export", { share_dir: shareDir });
  await kB.inv("sync.import", { share_dir: shareDir });
  assert.ok(kB.kernel.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, bobUserId]), "B 已有有效成员行");

  // A 移出 bob（墓碑 + 轮换 epoch=2，只包裹给 A）
  await kA.inv("matters.members.remove", { matter_id: matter.matter_id, user_id: bobUserId });
  const tomb = kA.kernel.db.get<any>(`SELECT removed_at, removed_lamport, author_device, row_lamport FROM matter_members WHERE matter_id = ? AND user_id = ?`, [matter.matter_id, bobUserId]);
  assert.ok(tomb.removed_at, "墓碑已落");
  await kA.inv("sync.export", { share_dir: shareDir });
  const imB = await kB.inv("sync.import", { share_dir: shareDir });
  // 轮换后 B 已无新纪元密钥：该段 body 对 B 不可解（skippedNoKey）——密钥分发即伦理墙兜底；
  // B 本地的 stale 有效行只是无牙残留（读块必失败），真正的风险是它回灌复活 A 的删除
  assert.ok(imB.skippedNoKey.includes(matter.matter_id), "B 无新纪元密钥（伦理墙兜底）");

  // B 的 stale 有效行回灌（row_lamport 更低）→ A 的墓碑必须胜
  await kB.inv("sync.export", { share_dir: shareDir });
  const imBack = await kA.inv("sync.import", { share_dir: shareDir });
  const aTomb2 = kA.kernel.db.get<any>(`SELECT removed_at FROM matter_members WHERE matter_id = ? AND user_id = ?`, [matter.matter_id, bobUserId]);
  assert.ok(aTomb2.removed_at, `回灌后 A 的墓碑仍在（stale 行不得复活删除）：${JSON.stringify(imBack)}`);

  // 再轮换（移出另一成员触发）：epoch 递增，bob 的设备不得出现新纪元包裹
  const otherId = "usr_sync-firm_other";
  await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: otherId });
  await kA.inv("matters.members.remove", { matter_id: matter.matter_id, user_id: otherId });
  const maxE = kA.kernel.db.get<any>(`SELECT MAX(epoch) AS e FROM matter_keys WHERE matter_id = ?`, [matter.matter_id]).e;
  assert.ok(maxE >= 3, `应已再次轮换：epoch=${maxE}`);
  const bobWrap = kA.kernel.db.get(`SELECT 1 AS x FROM matter_keys WHERE matter_id = ? AND epoch = ? AND wrapped_for = 'dev_sync-firm_bob'`, [matter.matter_id, maxE]);
  assert.equal(bobWrap, undefined, "被移出成员不得获得新纪元包裹（伦理墙）");
});

test("应当-3 merge 反例：非归属设备的大 lamport 行不得覆盖归属设备状态；重复导入幂等", { timeout: 180_000 }, async () => {
  // A 的 run 由 A 发起（origin=A）；B 篡改自己库里的 runs 行并导出 → A 必须保留并记 origin_conflict
  const { matter } = await kA.inv("matters.create", { title: "归属反例事项", stance: "受让方", consent_status: "not_required", collab_scope: "team", key_dates: { analysis_as_of: "2026-10-01" } });
  await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: "usr_sync-firm_bob" });
  const doc = await kA.inv("materials.import", { matter_id: matter.matter_id, filename: "x.txt", data_base64: Buffer.from("协议 第七条 保密义务。", "utf8").toString("base64"), mime: "text/plain" });
  const est = await kA.inv("runs.estimate", { matter_id: matter.matter_id, scenario: "s1.contract_review", document_version_ids: [doc.document_version_id] });
  const run = await kA.inv("runs.start", { matter_id: matter.matter_id, estimate_id: est.estimate_id, idempotency_key: `origin-${Date.now()}` });
  await kA.inv("sync.export", { share_dir: shareDir });
  await kB.inv("sync.import", { share_dir: shareDir });
  assert.ok(kB.kernel.db.get(`SELECT 1 AS x FROM runs WHERE run_id = ?`, [run.run_id]), "B 已同步 run 行");

  // 应当-3 回波免告警：B 原样回传（A→B→A 回波，内容逐字段一致）→ 不记 origin_conflict
  await kB.inv("sync.export", { share_dir: shareDir });
  const imEcho = await kA.inv("sync.import", { share_dir: shareDir });
  assert.ok(!imEcho.originConflicts.some((w: string) => w.startsWith("origin_conflict:runs/")), `回波不应告警：${JSON.stringify(imEcho.originConflicts)}`);

  // B（非归属）篡改 runs 行并以更大 lamport 导出
  kB.kernel.db.run(`UPDATE runs SET status = 'failed', cancel_reason = '非归属篡改', updated_at = ? WHERE run_id = ?`, [new Date().toISOString(), run.run_id]);
  await kB.inv("sync.export", { share_dir: shareDir });
  const im = await kA.inv("sync.import", { share_dir: shareDir });
  assert.ok(im.originConflicts.some((w: string) => w.startsWith("origin_conflict:runs/")), `应记 origin_conflict：${JSON.stringify(im.originConflicts)}`);
  const aRun = kA.kernel.db.get<any>(`SELECT status FROM runs WHERE run_id = ?`, [run.run_id]);
  assert.notEqual(aRun.status, "failed", "归属设备状态不被非归属覆盖");

  // 重复导入幂等：同 share 再导一次 → 计数与行数不变
  const im1 = await kB.inv("sync.import", { share_dir: shareDir });
  const countsBefore = ["users", "matters", "runs", "run_events", "matter_members"].map((t) => kB.kernel.db.get<any>(`SELECT COUNT(*) AS n FROM ${t}`, []).n);
  const im2 = await kB.inv("sync.import", { share_dir: shareDir });
  assert.equal(im2.segmentsApplied, 0, "已见过的段不再应用");
  assert.equal(im2.rowsApplied, 0, "重复导入不再产生新行");
  const countsAfter = ["users", "matters", "runs", "run_events", "matter_members"].map((t) => kB.kernel.db.get<any>(`SELECT COUNT(*) AS n FROM ${t}`, []).n);
  assert.deepEqual(countsAfter, countsBefore, "重复导入幂等（行数不变）");
  void im1;
});

test("应当-6：同步冲突的审计事件已上链（signed_events 见证）", { timeout: 180_000 }, async () => {
  const row = kA.kernel.db.get<any>(`SELECT audit_event_id FROM audit_events WHERE action = 'conflict.detected' ORDER BY audit_event_id DESC LIMIT 1`);
  assert.ok(row, "前置：存在 conflict.detected 审计");
  const witness = kA.kernel.db.get(`SELECT 1 AS x FROM signed_events WHERE kind = 'audit_event' AND ref_id = ?`, [String(row.audit_event_id)]);
  assert.ok(witness, "conflict.detected 应有 signed_events 见证（统一上链路径）");
});

test("阻断-C 复刻（恶意内部人）：伪造大 lamport 成员行翻墓碑 → 拒收；owner 合法变更仍同步", { timeout: 180_000 }, async () => {
  const bobUserId = "usr_sync-firm_bob";
  // 场景：A 的事项 + bob 成员 → 同步到 B（bob 持 epoch-1 密钥）→ A 移出 bob（墓碑 epoch 2，bob 出局）
  const { matter } = await kA.inv("matters.create", { title: "实验C事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: bobUserId });
  await kA.inv("sync.export", { share_dir: shareDir });
  await kB.inv("sync.import", { share_dir: shareDir });
  await kA.inv("matters.members.remove", { matter_id: matter.matter_id, user_id: bobUserId });
  await kA.inv("sync.export", { share_dir: shareDir });
  // bob 以合法证书伪造成员行：author_device=自己、row_lamport=99999、removed_at=null，epoch-1 密钥加密段体
  const { sealSegment, writeSegment } = await import("@zr-legal/sync");
  const { unwrapMatterKey } = await import("@zr-legal/keys");
  const { getDeviceKeys, keysDirOf } = await import("../src/index.ts");
  const bKeys = getDeviceKeys(keysDirOf(join(kB.dir, "sync-firm")));
  const bWrap = kB.kernel.db.get<any>(`SELECT wrapped_key FROM matter_keys WHERE matter_id = ? AND epoch = 1 AND wrapped_for = 'dev_sync-firm_bob'`, [matter.matter_id]);
  const k1 = unwrapMatterKey(bWrap.wrapped_key, bKeys.encPrivateKeyPem);
  const bCert = kB.kernel.db.get<any>(`SELECT cert_json FROM devices WHERE device_id = 'dev_sync-firm_bob'`);
  const forged = sealSegment({
    header: {
      segment_id: `seg_forged_${Date.now().toString(36)}`,
      device_id: "dev_sync-firm_bob",
      matter_id: matter.matter_id,
      from_lamport: 1,
      to_lamport: 99999,
      key_epoch: 1,
      event_count: 1,
      created_at: new Date().toISOString(),
      device_cert_json: bCert.cert_json,
    },
    keyRows: [],
    rows: [
      {
        t: "matter_members",
        pk: `${matter.matter_id}|${bobUserId}`,
        src_device: "dev_sync-firm_bob",
        src_lamport: 99999,
        row: { matter_id: matter.matter_id, user_id: bobUserId, matter_role: "editor", added_by: bobUserId, removed_at: null, removed_lamport: null, author_device: "dev_sync-firm_bob", row_lamport: 99999 },
      },
    ],
    matterKey: k1,
    signPrivateKeyPem: bKeys.signPrivateKeyPem,
  });
  writeSegment(shareDir, kA.kernel.identity.tenantId, "dev_sync-firm_bob", `seg_forged_${Date.now().toString(36)}`, forged);

  const im = await kA.inv("sync.import", { share_dir: shareDir });
  // bob 不是 owner——成员行整行拒收（member_row_rejected），墓碑不翻
  assert.ok(im.originConflicts.some((w: string) => w.startsWith("member_row_rejected:")), `应记 member_row_rejected：${JSON.stringify(im.originConflicts)}`);
  const tomb = kA.kernel.db.get<any>(`SELECT removed_at FROM matter_members WHERE matter_id = ? AND user_id = ?`, [matter.matter_id, bobUserId]);
  assert.ok(tomb.removed_at, "墓碑不被伪造行翻掉（阻断-C 闭合）");

  // 借名变体：伪造 author_device=owner 设备（但段由 bob 签名）→ author 与签名者不一致，同样拒收
  const forged2 = sealSegment({
    header: {
      segment_id: `seg_forged2_${Date.now().toString(36)}`,
      device_id: "dev_sync-firm_bob",
      matter_id: matter.matter_id,
      from_lamport: 1,
      to_lamport: 99999,
      key_epoch: 1,
      event_count: 1,
      created_at: new Date().toISOString(),
      device_cert_json: bCert.cert_json,
    },
    keyRows: [],
    rows: [
      {
        t: "matter_members",
        pk: `${matter.matter_id}|${bobUserId}`,
        src_device: "dev_sync-firm_test-lawyer",
        src_lamport: 99999,
        row: { matter_id: matter.matter_id, user_id: bobUserId, matter_role: "editor", added_by: bobUserId, removed_at: null, removed_lamport: null, author_device: "dev_sync-firm_test-lawyer", row_lamport: 99999 },
      },
    ],
    matterKey: k1,
    signPrivateKeyPem: bKeys.signPrivateKeyPem,
  });
  writeSegment(shareDir, kA.kernel.identity.tenantId, "dev_sync-firm_bob", `seg_forged2_${Date.now().toString(36)}`, forged2);
  const im2 = await kA.inv("sync.import", { share_dir: shareDir });
  assert.ok(im2.originConflicts.some((w: string) => w.includes("借名伪造拒收")), "借名变体同样拒收");
  assert.ok(kA.kernel.db.get<any>(`SELECT removed_at FROM matter_members WHERE matter_id = ? AND user_id = ?`, [matter.matter_id, bobUserId]).removed_at, "墓碑仍不翻");

  // owner 设备的合法成员变更在 A 侧不被误拒（A 侧直接可见；经同步到留存成员的验证见「墓碑 B 侧传播」用例）
  const otherId = "usr_sync-firm_other2";
  await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: otherId, matter_role: "editor" });
  assert.ok(kA.kernel.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, otherId]), "owner 合法 add 在 A 侧生效");
});

test("墓碑 B 侧传播（留存成员视角）：A 移出 carol → B（留存成员）收到墓碑且过滤生效", { timeout: 180_000 }, async () => {
  const bobUserId = "usr_sync-firm_bob";
  const carolId = "usr_sync-firm_carol";
  // A(owner) + bob(B) + carol：A 移出 carol → epoch 2 包裹给 A+bob+recovery → B 可解段体 → carol 墓碑到达 B
  const { matter } = await kA.inv("matters.create", { title: "墓碑传播事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: bobUserId });
  await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: carolId });
  await kA.inv("sync.export", { share_dir: shareDir });
  await kB.inv("sync.import", { share_dir: shareDir });
  await kA.inv("matters.members.remove", { matter_id: matter.matter_id, user_id: carolId });
  await kA.inv("sync.export", { share_dir: shareDir });
  const im = await kB.inv("sync.import", { share_dir: shareDir });
  // B 是留存成员（epoch 2 含 B 的包裹）→ 段体可解 → 墓碑到达
  assert.ok(!im.skippedNoKey.includes(matter.matter_id), `B 作为留存成员应能解段体：${JSON.stringify(im)}`);
  const bTomb = kB.kernel.db.get<any>(`SELECT removed_at FROM matter_members WHERE matter_id = ? AND user_id = ?`, [matter.matter_id, carolId]);
  assert.ok(bTomb?.removed_at, `B 库 carol 行应有墓碑：${JSON.stringify(bTomb)}`);
  // B 的成员过滤生效：有效成员查询不含 carol
  const active = kB.kernel.db.all(`SELECT user_id FROM matter_members WHERE matter_id = ? AND removed_at IS NULL`, [matter.matter_id]) as any[];
  assert.ok(!active.some((r) => r.user_id === carolId), "B 的有效成员集不含 carol");
  assert.ok(active.some((r) => r.user_id === bobUserId), "B（bob）仍是有效成员");

  // owner 合法 add 经同步到留存成员正常到达（作者资格通过、不误拒）
  const otherId = "usr_sync-firm_other3";
  await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: otherId, matter_role: "viewer" });
  await kA.inv("sync.export", { share_dir: shareDir });
  const im2 = await kB.inv("sync.import", { share_dir: shareDir });
  assert.ok(!im2.originConflicts.some((w: string) => w.startsWith("member_row_rejected:")), `owner 合法 add 不得误拒：${JSON.stringify(im2.originConflicts)}`);
  assert.ok(kB.kernel.db.get(`SELECT 1 AS x FROM matter_members WHERE matter_id = ? AND user_id = ? AND removed_at IS NULL`, [matter.matter_id, otherId]), "owner 合法 add 的成员行正常到达");
});

// 撤权放在最后：避免吊销 bob 设备污染其他用例的共享内核状态
test("撤权回填拒收：A 吊销 B 的设备 → B 新段（旧纪元）→ A 拒收", { timeout: 120_000 }, async () => {
  await kA.inv("devices.revoke", { device_id: "dev_sync-firm_bob", reason: "同步撤权探针" });
  await kB.inv("matters.create", { title: "撤权后事项", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  await kB.inv("sync.export", { share_dir: shareDir });
  const imA2 = await kA.inv("sync.import", { share_dir: shareDir });
  assert.ok(imA2.rejectedRevoked.length >= 1, `撤权设备旧纪元段应被拒收：${JSON.stringify(imA2)}`);
});

