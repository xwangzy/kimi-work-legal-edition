/**
 * 第 66 批（V40）事项—材料—成果关联：
 * K1 materials.import 同事项同内容去重（supersedes 绕过、隔离/移除后可再导入、跨事项不去重、mount 不去重）；
 * K2 materials.usage（材料被哪些任务勾过、任务勾了哪些材料、没勾材料的任务单列）；
 * K3 materials.remove（隔离同一机制，reason = removed_by_lawyer：权限、示例事项、进行中任务拒绝、块删除、成果待处置、预览与估价拒绝的说明）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importText, makeKernel, type TestKernel } from "./helpers.ts";

let tk: TestKernel;
before(async () => {
  tk = await makeKernel();
});
after(async () => {
  await tk.kernel.close();
});

async function newMatter(title: string): Promise<any> {
  return (await tk.inv("matters.create", { title, stance: "原告", consent_status: "not_required" })).matter;
}

function insertRun(matter: any, runId: string, status: string, docIds: string[], title: string): void {
  tk.kernel.db.run(
    `INSERT INTO runs (run_id, tenant_id, matter_id, scenario, workflow_version, status, idempotency_key, input_snapshot, budget_points, points_reserved, created_by)
     VALUES (?,?,?,?,'v5.0.0-g0',?,?,?,?,?,?)`,
    [runId, matter.tenant_id, matter.matter_id, "a1.agent_task", status, `b66-${runId}`, JSON.stringify({ document_version_ids: docIds, title, goal: `${title}的说明` }), 10, 10, matter.created_by],
  );
}

function insertArtifact(matter: any, runId: string, id: string, status = "pending_review"): void {
  tk.kernel.db.run(
    `INSERT INTO artifact_versions (artifact_version_id, tenant_id, matter_id, run_id, kind, audience, version, filename, sha256, storage_uri, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, matter.tenant_id, matter.matter_id, runId, `test_${id}`, "internal", 1, `${id}.md`, "0".repeat(64), "blob://none/0", status, matter.created_by],
  );
}

describe("K1 同事项同内容去重", () => {
  test("同内容再导入返回原来那份（duplicate、原名），不新建登记；文件名不同也不改名", async () => {
    const m = await newMatter("去重一");
    const a = await importText(tk.inv, m.matter_id, "借款合同.txt", "第一条 借款金额十万元。");
    assert.equal(a.duplicate, undefined);
    const b = await importText(tk.inv, m.matter_id, "借款合同（副本）.txt", "第一条 借款金额十万元。");
    assert.equal(b.duplicate, true);
    assert.equal(b.document_version_id, a.document_version_id);
    assert.equal(b.filename, "借款合同.txt", "返回原名");
    assert.ok(b.chars > 0, "带上解析字数，界面提示照常");
    const n = tk.kernel.db.get<any>(`SELECT COUNT(*) AS n FROM document_versions WHERE matter_id = ?`, [m.matter_id]).n;
    assert.equal(n, 1, "只有一条登记");
    assert.equal(tk.kernel.db.get<any>(`SELECT filename FROM document_versions WHERE document_version_id = ?`, [a.document_version_id]).filename, "借款合同.txt", "不改名");
    assert.ok(tk.kernel.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'materials.import_duplicate' AND object_id = ?`, [a.document_version_id]), "留审计");
  });

  test("带 supersedes（新版本）不去重；跨事项不去重；挂载不去重", async () => {
    const m = await newMatter("去重二");
    const a = await importText(tk.inv, m.matter_id, "当事人信息（律师填写）.txt", "原告：张某");
    const v2 = await tk.inv("materials.import", { matter_id: m.matter_id, filename: "当事人信息（律师填写）.txt", data_base64: Buffer.from("原告：张某").toString("base64"), mime: "text/plain", supersedes: a.document_version_id });
    assert.notEqual(v2.document_version_id, a.document_version_id, "新版本照常新建");
    assert.equal(v2.duplicate, undefined);
    // 被取代的旧版本不算：再导入同内容命中的是新版本
    const again = await importText(tk.inv, m.matter_id, "x.txt", "原告：张某");
    assert.equal(again.document_version_id, v2.document_version_id);

    const other = await newMatter("去重二-另一事项");
    const c = await importText(tk.inv, other.matter_id, "当事人信息（律师填写）.txt", "原告：张某");
    assert.notEqual(c.document_version_id, a.document_version_id, "跨事项不去重（块按事项加密）");
    assert.equal(c.duplicate, undefined);

    const dir = mkdtempSync(join(tmpdir(), "kwl-b66-mount-"));
    const path = join(dir, "合同.txt");
    writeFileSync(path, "第二条 利息按年 4%。");
    const m1 = await tk.inv("materials.mount", { matter_id: m.matter_id, path, mime: "text/plain" });
    const m2 = await tk.inv("materials.mount", { matter_id: m.matter_id, path, mime: "text/plain" });
    assert.notEqual(m1.document_version_id, m2.document_version_id, "挂载不去重");
    // 挂载过的内容再“导入副本”：挂载行不算（副本与引用语义不同）
    const imp = await importText(tk.inv, m.matter_id, "合同.txt", "第二条 利息按年 4%。");
    assert.equal(imp.duplicate, undefined);
  });

  test("移除后再导入同内容：重新保存一份", async () => {
    const m = await newMatter("去重三");
    const a = await importText(tk.inv, m.matter_id, "错放.txt", "别的案子的材料");
    await tk.inv("materials.remove", { document_version_id: a.document_version_id });
    const b = await importText(tk.inv, m.matter_id, "错放.txt", "别的案子的材料");
    assert.notEqual(b.document_version_id, a.document_version_id);
    assert.equal(b.duplicate, undefined);
  });
});

describe("K2 materials.usage", () => {
  test("材料被哪些任务勾过、任务勾了哪些材料、没勾材料的任务单列", async () => {
    const m = await newMatter("关联");
    const a = await importText(tk.inv, m.matter_id, "起诉状.txt", "诉讼请求：判令被告还款。");
    const b = await importText(tk.inv, m.matter_id, "借条.txt", "今借到人民币十万元。");
    insertRun(m, "run_b66_u1", "succeeded", [a.document_version_id], "审起诉状");
    insertRun(m, "run_b66_u2", "succeeded", [a.document_version_id, b.document_version_id], "整理证据");
    insertRun(m, "run_b66_u3", "succeeded", [], "不限材料");
    insertArtifact(m, "run_b66_u2", "art_b66_u2a");
    insertArtifact(m, "run_b66_u2", "art_b66_u2b", "superseded");
    const u = await tk.inv("materials.usage", { matter_id: m.matter_id });
    const da = u.documents.find((d: any) => d.document_version_id === a.document_version_id);
    const db2 = u.documents.find((d: any) => d.document_version_id === b.document_version_id);
    assert.deepEqual(da.used_by.map((r: any) => r.run_id).sort(), ["run_b66_u1", "run_b66_u2"]);
    assert.deepEqual(db2.used_by.map((r: any) => r.run_id), ["run_b66_u2"]);
    assert.equal(db2.used_by[0].title, "整理证据");
    assert.equal(db2.used_by[0].artifact_count, 1, "被替代的成果不算");
    assert.equal(u.unrestricted_runs, 1);
    assert.equal(da.readable_by_unrestricted, 1, "在它之后发起的不限材料任务");
    const r2 = u.runs.find((r: any) => r.run_id === "run_b66_u2");
    assert.equal(r2.scope, "selected");
    assert.deepEqual(r2.document_version_ids, [a.document_version_id, b.document_version_id]);
    assert.equal(u.runs.find((r: any) => r.run_id === "run_b66_u3").scope, "all");
    // 读权限：非成员看不到
    tk.kernel.db.run(`UPDATE matter_members SET removed_at = CURRENT_TIMESTAMP WHERE matter_id = ?`, [m.matter_id]);
    await assert.rejects(() => tk.inv("materials.usage", { matter_id: m.matter_id }), (e: any) => e.code === "forbidden" || e.code === "not_found");
    tk.kernel.db.run(`UPDATE matter_members SET removed_at = NULL WHERE matter_id = ?`, [m.matter_id]);
  });
});

describe("K3 materials.remove", () => {
  test("移除：删副本块与解析文字、登记标已移除、成果标“依据材料已被移除”、预览与估价按原因说明、审计 materials.removed", async () => {
    const m = await newMatter("移除");
    const a = await importText(tk.inv, m.matter_id, "错放的合同.txt", "第一条 付款。金丝雀KWL-B66-REMOVE");
    const keep = await importText(tk.inv, m.matter_id, "留下的.txt", "第一条 交货。");
    insertRun(m, "run_b66_r1", "succeeded", [a.document_version_id], "审合同");
    insertArtifact(m, "run_b66_r1", "art_b66_r1", "approved");
    const uri = tk.kernel.db.get<any>(`SELECT storage_uri FROM document_versions WHERE document_version_id = ?`, [a.document_version_id]).storage_uri;
    const r = await tk.inv("materials.remove", { document_version_id: a.document_version_id });
    assert.equal(r.removed, true);
    assert.equal(r.affected_artifacts, 1);
    assert.match(r.note, /原文件不受影响/);
    const row = tk.kernel.db.get<any>(`SELECT quarantined_at, quarantine_reason FROM document_versions WHERE document_version_id = ?`, [a.document_version_id]);
    assert.ok(row.quarantined_at);
    assert.equal(row.quarantine_reason, "removed_by_lawyer");
    assert.throws(() => tk.kernel.blobs.read(uri), "副本块已删除");
    assert.equal(tk.kernel.db.get<any>(`SELECT COUNT(*) AS n FROM parse_texts WHERE parse_version_id IN (SELECT parse_version_id FROM parse_versions WHERE document_version_id = ?)`, [a.document_version_id]).n, 0);
    // 已签发成果不撤回，只标待处置
    const art = tk.kernel.db.get<any>(`SELECT status, open_items FROM artifact_versions WHERE artifact_version_id = 'art_b66_r1'`);
    assert.equal(art.status, "approved", "不自动撤回签发");
    const items = JSON.parse(art.open_items);
    assert.equal(items.at(-1).kind, "quarantined_source");
    assert.equal(items.at(-1).reason, "removed_by_lawyer");
    assert.match(items.at(-1).note, /已被律师移除/);
    assert.doesNotMatch(items.at(-1).note, /国家秘密/);
    await assert.rejects(() => tk.inv("materials.text", { document_version_id: a.document_version_id }), (e: any) => e.code === "conflict" && /已被移除/.test(e.message) && !/国家秘密/.test(e.message));
    await assert.rejects(
      () => tk.inv("runs.estimate", { matter_id: m.matter_id, scenario: "s1.contract_review", document_version_ids: [a.document_version_id] }),
      (e: any) => e.code === "conflict" && /已移除/.test(e.message) && !/国家秘密/.test(e.message),
    );
    assert.ok(tk.kernel.db.get(`SELECT 1 AS x FROM audit_events WHERE action = 'materials.removed' AND object_id = ?`, [a.document_version_id]));
    // 同事项其他材料不受影响；再移除一次幂等
    assert.equal(tk.kernel.db.get<any>(`SELECT quarantined_at FROM document_versions WHERE document_version_id = ?`, [keep.document_version_id]).quarantined_at, null);
    assert.equal((await tk.inv("materials.remove", { document_version_id: a.document_version_id })).already, true);
    // 搜索与 matters.get：登记行留着、带原因（界面据此区分“已移除”与“已隔离”）
    const got = await tk.inv("matters.get", { matter_id: m.matter_id });
    assert.ok(got.documents.find((d: any) => d.document_version_id === a.document_version_id).quarantined_at);
  });

  test("挂载的只解除引用，原文件不动", async () => {
    const m = await newMatter("移除挂载");
    const dir = mkdtempSync(join(tmpdir(), "kwl-b66-rm-"));
    const path = join(dir, "原件.txt");
    writeFileSync(path, "原件内容");
    const d = await tk.inv("materials.mount", { matter_id: m.matter_id, path, mime: "text/plain" });
    const r = await tk.inv("materials.remove", { document_version_id: d.document_version_id });
    assert.equal(r.storage_mode, "mount");
    assert.match(r.note, /原文件仍在原位置/);
    assert.ok(existsSync(path), "原文件还在");
  });

  test("守卫：viewer 拒绝、示例事项拒绝、进行中任务勾了它（或不限材料）拒绝", async () => {
    const m = await newMatter("移除守卫");
    const a = await importText(tk.inv, m.matter_id, "在用.txt", "正在审的合同");
    const db = tk.kernel.db;
    db.run(`UPDATE matter_members SET matter_role = 'viewer' WHERE matter_id = ?`, [m.matter_id]);
    await assert.rejects(() => tk.inv("materials.remove", { document_version_id: a.document_version_id }), (e: any) => e.code === "forbidden");
    db.run(`UPDATE matter_members SET matter_role = 'owner' WHERE matter_id = ?`, [m.matter_id]);

    insertRun(m, "run_b66_g1", "running", [a.document_version_id], "正在审的任务");
    await assert.rejects(
      () => tk.inv("materials.remove", { document_version_id: a.document_version_id }),
      (e: any) => e.code === "material_in_use" && /正在审的任务/.test(e.message) && e.detail?.run_ids?.includes("run_b66_g1"),
    );
    db.run(`UPDATE runs SET status = 'succeeded' WHERE run_id = 'run_b66_g1'`);
    insertRun(m, "run_b66_g2", "waiting_input", [], "不限材料的任务");
    await assert.rejects(() => tk.inv("materials.remove", { document_version_id: a.document_version_id }), (e: any) => e.code === "material_in_use");
    db.run(`UPDATE runs SET status = 'cancelled' WHERE run_id = 'run_b66_g2'`);
    // 进行中的任务勾的是别的材料：不挡
    const b = await importText(tk.inv, m.matter_id, "别的.txt", "另一份");
    insertRun(m, "run_b66_g3", "running", [b.document_version_id], "只用别的");
    assert.equal((await tk.inv("materials.remove", { document_version_id: a.document_version_id })).removed, true);

    const s = await newMatter("示例");
    const sd = await importText(tk.inv, s.matter_id, "示例合同.txt", "示例");
    db.run(`INSERT INTO sample_matters (matter_id) VALUES (?)`, [s.matter_id]);
    await assert.rejects(() => tk.inv("materials.remove", { document_version_id: sd.document_version_id }), (e: any) => e.code === "validation" && /示例事项/.test(e.message));
    await assert.rejects(() => tk.inv("materials.remove", { document_version_id: "nope" }), (e: any) => e.code === "not_found");
  });

  test("国家秘密标志的隔离说明不变（回归）", async () => {
    const m = await newMatter("隔离回归");
    const a = await importText(tk.inv, m.matter_id, "旧.txt", "第一条");
    tk.kernel.db.run(`UPDATE document_versions SET quarantined_at = CURRENT_TIMESTAMP, quarantine_reason = 'state_secret_marking' WHERE document_version_id = ?`, [a.document_version_id]);
    await assert.rejects(() => tk.inv("materials.text", { document_version_id: a.document_version_id }), (e: any) => e.code === "conflict" && /国家秘密标志/.test(e.message));
    await assert.rejects(
      () => tk.inv("runs.estimate", { matter_id: m.matter_id, scenario: "s1.contract_review", document_version_ids: [a.document_version_id] }),
      (e: any) => e.code === "conflict" && /国家秘密标志/.test(e.message),
    );
  });
});
