/**
 * 第 48 批 案卷文件夹：关联本机文件夹并递归导入（rel_path）、再同步不重复、改过的文件作新版本（supersedes）、
 * 删掉的只报告不删材料、链接与 Office 锁文件与隐藏文件跳过、旧格式与不支持的格式说明原因、与此前普通导入按内容去重、
 * 同一事项同时只跑一次同步、已结案拒绝、已隔离的内容不再导入；材料内搜索（片段、多词同时出现、已隔离的不出现）；
 * 团队同步不带本机文件夹路径；删除事项清掉路径与文件夹位置。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { importText, makeKernel, type TestKernel } from "./helpers.ts";
import { ignoredFolderEntry, searchTerms, snippetAround } from "../src/services/matter-folder.ts";
import { legacyFormatNotice } from "../src/services/parser.ts";
import { DEVICE_LOCAL_COLUMNS, withoutDeviceLocal } from "../src/sync-engine.ts";

let tk: TestKernel;
const dirs: string[] = [];
before(async () => {
  tk = await makeKernel({}, "b48-folder-firm");
});
after(async () => {
  await tk.kernel.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempFolder(label: string): string {
  const d = mkdtempSync(join(tmpdir(), `kwl-b48-${label}-`));
  dirs.push(d);
  return d;
}
function put(root: string, rel: string, text: string | Buffer): string {
  const p = join(root, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}
const docsOf = async (mid: string) => (await tk.inv("matters.get", { matter_id: mid })).documents as any[];

const COPY_TEXT = "律师函（复印件）：请于七日内支付货款。";
const CONTRACT_V1 = "买卖合同\n第七条 违约金：逾期付款的，按日万分之五支付违约金（Penalty clause）。\n第八条 争议解决：提交北京仲裁委员会仲裁。";
const CONTRACT_V2 = "买卖合同（补充后）\n第七条 违约金：逾期付款的，按日千分之一支付违约金（Penalty clause）。";

describe("案卷文件夹：关联、同步、去重、版本、报告", () => {
  let mid: string;
  let root: string;

  before(async () => {
    const { matter } = await tk.inv("matters.create", { title: "案卷文件夹事项", stance: "原告", consent_status: "not_required" });
    mid = matter.matter_id;
    // 关联之前用普通方式添加过一份（内容与文件夹里的“复印件/律师函副本.txt”相同）
    await importText(tk.inv, mid, "律师函.txt", COPY_TEXT);
    root = tempFolder("case");
    put(root, "起诉状.txt", "民事起诉状\n原告：张三\n被告：某某公司\n诉讼请求：判令被告支付货款及违约金。");
    put(root, "证据/合同.txt", CONTRACT_V1);
    put(root, "证据/补充/付款记录.csv", "日期,金额\n2024-03-01,10000\n");
    put(root, "复印件/律师函副本.txt", COPY_TEXT);
    // 跳过：Office 锁文件、隐藏文件、系统缩略图（不报告）；链接、旧格式、不支持的格式、空文件、层级太深（报告原因）
    put(root, "~$起诉状.txt", "lock");
    put(root, ".DS_Store", "x");
    put(root, ".隐藏/秘密.txt", "不该导入");
    put(root, "Thumbs.db", "x");
    const outside = put(tempFolder("outside"), "外部.txt", "文件夹以外的文件，不应被引入");
    symlinkSync(outside, join(root, "快捷方式.txt"));
    put(root, "旧版答辩状.doc", "x");
    put(root, "现场照片.heic", "x");
    put(root, "空白.txt", "");
    put(root, "a/b/c/d/e/f/g/h/i/太深.txt", "层级太深");
  });

  test("关联即同步：递归导入、记下文件夹里的位置；内容与此前添加的相同的不重复导入；跳过的逐条说明原因", async () => {
    const r = await tk.inv("materials.link_folder", { matter_id: mid, path: root });
    assert.equal(r.added, 3, JSON.stringify(r));
    assert.equal(r.updated, 0);
    assert.equal(r.unchanged, 1, "复印件与此前普通导入的内容相同：去重");
    assert.equal(r.capped, false);
    assert.deepEqual(r.missing_on_disk, []);
    assert.equal(r.folder.name, basename(root));
    assert.ok(r.folder.linked_at && r.folder.synced_at);
    const reason = (rel: string) => r.skipped.find((s: any) => s.rel_path === rel)?.reason as string | undefined;
    assert.match(reason("快捷方式.txt") ?? "", /链接/);
    assert.match(reason("旧版答辩状.doc") ?? "", /另存为/);
    assert.match(reason("现场照片.heic") ?? "", /读不了/);
    assert.match(reason("空白.txt") ?? "", /空文件/);
    assert.match(reason("a/b/c/d/e/f/g/h/i/") ?? "", /层级太深/);
    for (const silent of ["~$起诉状.txt", ".DS_Store", "Thumbs.db", ".隐藏/秘密.txt"]) assert.equal(reason(silent), undefined, `${silent} 不报告`);
    assert.equal(r.skipped_total, r.skipped.length);

    const docs = await docsOf(mid);
    const byRel = new Map(docs.filter((d) => d.rel_path).map((d) => [d.rel_path, d]));
    // 此前逐个添加的“律师函.txt”与文件夹里的“复印件/律师函副本.txt”内容相同：不重复导入，按内容认回文件夹位置（复核第 48 批 #1）
    assert.deepEqual([...byRel.keys()].sort(), ["复印件/律师函副本.txt", "证据/合同.txt", "证据/补充/付款记录.csv", "起诉状.txt"].sort());
    assert.equal(byRel.get("证据/补充/付款记录.csv").filename, "付款记录.csv");
    assert.equal(byRel.get("证据/合同.txt").storage_mode, "import", "复制并加密保存，不是只引用");
    assert.equal(byRel.get("证据/合同.txt").mime, "text/plain");
    assert.ok(!docs.some((d) => /外部|秘密|太深|lock/.test(d.filename)), "链接、隐藏、太深的文件都没有导入");
    assert.equal(docs.find((d) => d.filename === "律师函.txt").rel_path, "复印件/律师函副本.txt", "内容相同的普通导入材料认回文件夹位置（文件名不变）");
    // 每份照常走导入：各有一条 materials.import 审计；关联与同步各一条，审计不记路径
    const db = tk.kernel.db;
    assert.equal(db.get<any>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'materials.import' AND object_id = ?`, [byRel.get("起诉状.txt").document_version_id]).n, 1);
    const linkAudit = db.get<any>(`SELECT detail_hash FROM audit_events WHERE action = 'materials.link_folder' AND object_id = ?`, [mid]);
    assert.ok(linkAudit && !String(linkAudit.detail_hash).includes(root));
    // matters.get 带文件夹视图
    const m = (await tk.inv("matters.get", { matter_id: mid })).matter;
    assert.equal(m.folder.root, db.get<any>(`SELECT folder_root FROM matters WHERE matter_id = ?`, [mid]).folder_root);
  });

  test("再同步：没有变化即 0 新增；改过的文件作为新版本（supersedes 指向上一版）；删掉的只报告、材料还在", async () => {
    const again = await tk.inv("materials.sync_folder", { matter_id: mid });
    assert.equal(again.added, 0);
    assert.equal(again.updated, 0);
    assert.equal(again.unchanged, 4);

    const before = (await docsOf(mid)).find((d) => d.rel_path === "证据/合同.txt");
    put(root, "证据/合同.txt", CONTRACT_V2);
    rmSync(join(root, "起诉状.txt"));
    const r = await tk.inv("materials.sync_folder", { matter_id: mid });
    assert.equal(r.added, 0);
    assert.equal(r.updated, 1);
    assert.deepEqual(r.missing_on_disk, ["起诉状.txt"]);
    const docs = await docsOf(mid);
    const versions = docs.filter((d) => d.rel_path === "证据/合同.txt");
    assert.equal(versions.length, 2, "原件不可变：旧版保留");
    const latest = versions.find((d) => d.document_version_id !== before.document_version_id);
    assert.equal(latest.supersedes, before.document_version_id);
    assert.ok(docs.some((d) => d.rel_path === "起诉状.txt"), "文件夹里删掉的材料仍在事项里");
    assert.ok(Date.parse((await tk.inv("matters.get", { matter_id: mid })).matter.folder.synced_at) >= Date.parse(r.synced_at) - 1);
  });

  test("同一事项同时只跑一次同步：第二次说明正在同步", async () => {
    const first = tk.inv("materials.sync_folder", { matter_id: mid });
    const second = tk.inv("materials.sync_folder", { matter_id: mid });
    await assert.rejects(second, (e: any) => e.code === "conflict" && /正在同步/.test(e.message));
    await first;
    await assert.rejects(tk.inv("materials.unlink_folder", { matter_id: mid }).then(() => tk.inv("materials.sync_folder", { matter_id: mid })), (e: any) => e.code === "validation" && /还没有关联/.test(e.message));
    // 重新关联（取消关联不删材料；再关联同一文件夹，内容相同的都算“没有变化”）
    const n = (await docsOf(mid)).length;
    const re = await tk.inv("materials.link_folder", { matter_id: mid, path: root });
    assert.equal(re.added, 0);
    assert.equal((await docsOf(mid)).length, n);
  });

  test("改关联到另一个文件夹：同名文件不当成旧文件的新版本，旧文件夹的文件不报“找不到”；改回原文件夹按内容认回（复核第 48 批 #1）", async () => {
    const other = tempFolder("other");
    put(other, "证据/合同.txt", "另一个案子的合同：与本案无关。");
    const r = await tk.inv("materials.link_folder", { matter_id: mid, path: other });
    assert.equal(r.added, 1, JSON.stringify(r));
    assert.equal(r.updated, 0, "不是本案合同的新版本");
    assert.deepEqual(r.missing_on_disk, [], "原文件夹的文件不再算这个文件夹里“找不到”的");
    const docs = await docsOf(mid);
    const fresh = docs.find((d) => d.rel_path === "证据/合同.txt");
    assert.equal(fresh.supersedes, null);
    // 改回原文件夹：内容没变的文件按内容认回位置，不重复导入
    const n = docs.length;
    const back = await tk.inv("materials.link_folder", { matter_id: mid, path: root });
    assert.equal(back.added + back.updated, 0, JSON.stringify(back));
    assert.equal((await docsOf(mid)).length, n);
    assert.ok((await docsOf(mid)).some((d) => d.rel_path === "证据/补充/付款记录.csv"), "仍在原文件夹里的文件认回位置");
  });

  test("材料内搜索：文件名与文字、片段前后文、多个词须同时出现、不分大小写；已隔离的材料不出现，其内容也不再导入", async () => {
    const r = await tk.inv("materials.search", { matter_id: mid, q: "违约金" });
    // 取消关联再关联后，只有当前那一版认回文件夹位置；旧版留在事项里（仍由新版的 supersedes 标为旧版本），按文件名找
    const contract = r.hits.filter((h: any) => h.filename === "合同.txt");
    assert.equal(contract.length, 2, "两个版本都含“违约金”");
    for (const h of contract) {
      assert.ok(h.hits >= 1);
      assert.match(h.snippet, /违约金/);
      assert.ok(h.snippet.length <= 40 * 2 + "违约金".length + 2 + 2, h.snippet);
    }
    assert.ok(r.hits.some((h: any) => h.filename === "起诉状.txt"), "起诉状里也有（文件夹里已删掉，材料仍在事项里）");
    // 多词同时出现、不分大小写
    const both = await tk.inv("materials.search", { matter_id: mid, q: "违约金  PENALTY" });
    assert.deepEqual([...new Set(both.hits.map((h: any) => h.filename))], ["合同.txt"]);
    assert.equal((await tk.inv("materials.search", { matter_id: mid, q: "违约金 根本没有的词" })).hits.length, 0);
    // 只有文件名命中：片段为 null
    const byName = await tk.inv("materials.search", { matter_id: mid, q: "付款记录" });
    const rec = byName.hits.find((h: any) => h.rel_path === "证据/补充/付款记录.csv");
    assert.ok(rec && rec.name_match === true && rec.snippet === null);
    // 按文件夹位置也能找到
    assert.ok((await tk.inv("materials.search", { matter_id: mid, q: "补充" })).hits.some((h: any) => h.rel_path === "证据/补充/付款记录.csv"));
    // LIKE 通配符按字面
    assert.equal((await tk.inv("materials.search", { matter_id: mid, q: "%" })).hits.length, 0);
    assert.deepEqual((await tk.inv("materials.search", { matter_id: mid, q: "   " })).hits, []);

    // 隔离最新版（直接标记：搜索只认 quarantined_at，不靠解析文字已删除）
    const db = tk.kernel.db;
    const latest = (await docsOf(mid)).find((d) => d.rel_path === "证据/合同.txt" && d.supersedes);
    db.run(`UPDATE document_versions SET quarantined_at = ?, quarantine_reason = 'state_secret_marking' WHERE document_version_id = ?`, [new Date().toISOString(), latest.document_version_id]);
    const after = await tk.inv("materials.search", { matter_id: mid, q: "千分之一" });
    assert.equal(after.hits.length, 0, "已隔离的材料不出现在搜索结果里");
    // 文件夹里仍是这份内容：不再导入，说明原因
    const s = await tk.inv("materials.sync_folder", { matter_id: mid });
    assert.equal(s.added + s.updated, 0);
    assert.match(s.skipped.find((x: any) => x.rel_path === "证据/合同.txt")?.reason ?? "", /隔离/);
  });
});

describe("案卷文件夹：权限与生命周期", () => {
  test("已结案的事项不能关联或同步（可以取消关联）；路径须是本机文件夹；不能关联应用自己的数据目录", async () => {
    const { matter } = await tk.inv("matters.create", { title: "结案事项", stance: "被告", consent_status: "not_required" });
    const root = tempFolder("closed");
    put(root, "答辩状.txt", "民事答辩状");
    await assert.rejects(tk.inv("materials.link_folder", { matter_id: matter.matter_id, path: "相对/路径" }), (e: any) => e.code === "validation");
    await assert.rejects(tk.inv("materials.link_folder", { matter_id: matter.matter_id, path: join(root, "答辩状.txt") }), (e: any) => e.code === "validation" && /不是文件夹/.test(e.message));
    for (const appDir of [tk.dir, tk.kernel.config.workspaceDir]) {
      await assert.rejects(tk.inv("materials.link_folder", { matter_id: matter.matter_id, path: appDir }), (e: any) => e.code === "validation" && /数据目录/.test(e.message), appDir);
    }
    await tk.inv("materials.link_folder", { matter_id: matter.matter_id, path: root });
    await tk.inv("matters.close", { matter_id: matter.matter_id, retention_years: 1 });
    await assert.rejects(tk.inv("materials.sync_folder", { matter_id: matter.matter_id }), (e: any) => e.code === "conflict" && /结案/.test(e.message));
    await assert.rejects(tk.inv("materials.link_folder", { matter_id: matter.matter_id, path: root }), (e: any) => e.code === "conflict");
    await tk.inv("materials.unlink_folder", { matter_id: matter.matter_id });
    assert.equal((await tk.inv("matters.get", { matter_id: matter.matter_id })).matter.folder, null);
  });

  test("超过 500 份可导入的文件：只处理前 500 份并如实报告；再同步不重复导入", { timeout: 120_000 }, async () => {
    const { matter } = await tk.inv("matters.create", { title: "超量文件夹", stance: "原告", consent_status: "not_required" });
    const root = tempFolder("big");
    for (let i = 0; i < 502; i++) put(root, `卷${String(Math.floor(i / 100))}/第${String(i).padStart(3, "0")}页.txt`, `第 ${i} 页的内容`);
    const r = await tk.inv("materials.link_folder", { matter_id: matter.matter_id, path: root });
    assert.equal(r.capped, true);
    assert.equal(r.cap, 500);
    assert.equal(r.scanned, 500);
    assert.equal(r.added, 500);
    assert.deepEqual(r.missing_on_disk, []);
    const again = await tk.inv("materials.sync_folder", { matter_id: matter.matter_id });
    assert.equal(again.added, 0);
    assert.equal(again.unchanged, 500);
    assert.equal(again.capped, true);
  });

  test("删除事项：关联文件夹的路径与材料的文件夹位置一并清除", async () => {
    const title = "待删除的文件夹事项";
    const { matter } = await tk.inv("matters.create", { title, stance: "原告", consent_status: "not_required" });
    const root = tempFolder("张三案卷");
    put(root, "张三/证据一.txt", "证据一");
    await tk.inv("materials.link_folder", { matter_id: matter.matter_id, path: root });
    await tk.inv("matters.close", { matter_id: matter.matter_id, retention_years: 1 });
    await tk.inv("matters.purge", { matter_id: matter.matter_id, confirm_title: title, early: true, reason: "测试删除" });
    const db = tk.kernel.db;
    const m = db.get<any>(`SELECT folder_root, folder_linked_at, folder_synced_at FROM matters WHERE matter_id = ?`, [matter.matter_id]);
    assert.deepEqual({ ...m }, { folder_root: null, folder_linked_at: null, folder_synced_at: null });
    assert.equal(db.get<any>(`SELECT COUNT(*) AS n FROM document_versions WHERE matter_id = ? AND rel_path IS NOT NULL`, [matter.matter_id]).n, 0);
  });
});

describe("团队同步：本机文件夹路径不出这台电脑，材料的文件夹位置照常同步", () => {
  test("A 关联文件夹后导出 → B 收到材料与文件夹位置、没有路径；B 回传 → A 不因本机路径报归属冲突、路径不被覆盖", { timeout: 120_000 }, async () => {
    const kA = await makeKernel({}, "b48-sync-firm");
    const wsB = tempFolder("wsB");
    mkdirSync(join(wsB, "b48-sync-firm", "keys"), { recursive: true });
    copyFileSync(join(kA.dir, "b48-sync-firm", "keys", "firm-root.json"), join(wsB, "b48-sync-firm", "keys", "firm-root.json"));
    const { createKernel } = await import("../src/index.ts");
    const kernelB = await createKernel({ dataDir: wsB, firmSlug: "b48-sync-firm", userSlug: "bob", env: { ...process.env, ZR_MODEL_PROVIDER: "mock" } });
    try {
      const bobDev = kernelB.db.get<any>(`SELECT * FROM devices WHERE device_id = 'dev_b48-sync-firm_bob'`);
      kA.kernel.db.run(
        `INSERT OR IGNORE INTO devices (device_id, tenant_id, member_id, role, sign_pub_pem, enc_pub_pem, cert_json, status, key_epoch_at_issue) VALUES (?,?,?,?,?,?,?, 'active', 1)`,
        [bobDev.device_id, bobDev.tenant_id, bobDev.member_id, bobDev.role, bobDev.sign_pub_pem, bobDev.enc_pub_pem, bobDev.cert_json],
      );
      const { matter } = await kA.inv("matters.create", { title: "团队案卷", stance: "原告", consent_status: "not_required", collab_scope: "team" });
      await kA.inv("matters.members.add", { matter_id: matter.matter_id, user_id: "usr_b48-sync-firm_bob" });
      const root = tempFolder("张三团队案卷");
      put(root, "证据/合同.txt", CONTRACT_V1);
      await kA.inv("materials.link_folder", { matter_id: matter.matter_id, path: root });
      const rootA = kA.kernel.db.get<any>(`SELECT folder_root FROM matters WHERE matter_id = ?`, [matter.matter_id]).folder_root;
      assert.ok(rootA);

      const share = tempFolder("share");
      await kA.inv("sync.export", { share_dir: share });
      await kernelB.invoke("sync.import", { share_dir: share });
      const mB = kernelB.db.get<any>(`SELECT folder_root, folder_linked_at, folder_synced_at FROM matters WHERE matter_id = ?`, [matter.matter_id]);
      assert.ok(mB, "B 收到了事项");
      assert.deepEqual({ ...mB }, { folder_root: null, folder_linked_at: null, folder_synced_at: null }, "本机路径没有同步给 B");
      assert.equal(kernelB.db.get<any>(`SELECT rel_path FROM document_versions WHERE matter_id = ?`, [matter.matter_id])?.rel_path, "证据/合同.txt", "文件夹位置随材料同步");

      // B 回传（B 导出的事项行不带路径列）：A 不报归属冲突，A 的路径还在
      await kernelB.invoke("sync.export", { share_dir: share });
      const back = await kA.inv("sync.import", { share_dir: share });
      assert.ok(back.segmentsApplied >= 1, "A 应用了 B 的段（回波比对确实发生）");
      assert.ok(!(back.originConflicts as string[]).some((w) => w.includes(`matters/${matter.matter_id}`)), JSON.stringify(back.originConflicts));
      assert.equal(kA.kernel.db.get<any>(`SELECT folder_root FROM matters WHERE matter_id = ?`, [matter.matter_id]).folder_root, rootA);
    } finally {
      await kernelB.close().catch(() => {});
      await kA.kernel.close().catch(() => {});
    }
  });
});

describe("纯函数", () => {
  test("团队同步不带本机文件夹路径：导出去掉、收到的行里有也丢掉（材料的文件夹位置照常同步）", () => {
    const row = { matter_id: "m1", title: "t", folder_root: "/Users/a/案卷/张三", folder_linked_at: "x", folder_synced_at: "y" };
    assert.deepEqual(withoutDeviceLocal("matters", row), { matter_id: "m1", title: "t" });
    const plain = { matter_id: "m2" };
    assert.equal(withoutDeviceLocal("matters", plain), plain, "没有本机列时原样返回");
    assert.deepEqual(withoutDeviceLocal("document_versions", { rel_path: "证据/a.docx" }), { rel_path: "证据/a.docx" });
    assert.deepEqual(DEVICE_LOCAL_COLUMNS.matters, ["folder_root", "folder_linked_at", "folder_synced_at"]);
  });

  test("文件名过滤、旧格式说明、搜索词与片段", () => {
    for (const n of ["~$合同.docx", ".DS_Store", ".git", "Thumbs.db", "desktop.ini", "~WRL0001.tmp"]) assert.ok(ignoredFolderEntry(n), n);
    for (const n of ["合同.docx", "~合同.docx", "证据.pdf"]) assert.ok(!ignoredFolderEntry(n), n);
    assert.match(legacyFormatNotice("答辩状.DOC") ?? "", /另存为.*docx/);
    assert.match(legacyFormatNotice("报表.et") ?? "", /xlsx/);
    assert.match(legacyFormatNotice("来信.msg") ?? "", /Outlook/);
    assert.equal(legacyFormatNotice("合同.docx"), null);
    assert.deepEqual(searchTerms("  违约金　Penalty penalty  "), ["违约金", "Penalty"]);
    assert.equal(searchTerms("a b c d e f g h i j").length, 8);
    const text = `${"甲".repeat(100)}违约金${"乙".repeat(100)}`;
    const s = snippetAround(text, 100, 3);
    assert.equal(s, `…${"甲".repeat(40)}违约金${"乙".repeat(40)}…`);
    assert.equal(snippetAround("违约金\n\n按日计算", 0, 3), "违约金 按日计算");
  });
});
