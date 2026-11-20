/**
 * 案卷文件夹（第 48 批）：事项就是工作区——律师把本机的一个案卷文件夹关联到事项，点“同步”时把里面新增、改过的文件
 * 逐份走正常的导入（materials.import：解析、国家秘密标志检测、加密保存副本、审计），按内容（sha256）去重；
 * 文件夹里删掉的文件只报告、不删事项材料。不监听文件夹、不后台同步、不做“只引用不复制”的文件夹挂载。
 *
 * 文件夹的绝对路径只属于这台电脑（matters.folder_root）：团队同步不导出、不接收（sync-engine.ts DEVICE_LOCAL_COLUMNS）。
 * 材料在文件夹里的位置（document_versions.rel_path）随材料行同步：与文件名同等敏感、只在加密段体里，同事据此看到目录结构；
 * 版本衔接（同一位置内容变了）与“文件夹里找不到了”只看这台电脑导入的材料——别的电脑关联的是它自己的文件夹。
 *
 * 材料内搜索（materials.search）：只在本机，按文件名、文件夹位置与最新解析文字做不分大小写的子串搜索，空格分隔的词须同时出现。
 * 不写审计（搜索词里可能有当事人姓名；只读操作，与“查看材料原文”同一口径）。
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DomainError, sha256Hex, validation } from "@zr-legal/domain";
import { nowIso, type KernelDb } from "../db.ts";
import type { Identity } from "../identity.ts";
import { legacyFormatNotice } from "./parser.ts";

/** 子文件夹至多 8 层（根目录下的文件是第 0 层）。 */
export const FOLDER_MAX_DEPTH = 8;
/** 一次同步至多处理 500 份可导入的文件（超出的下次同步不会自动接上——如实报告，请律师把文件夹拆小）。 */
export const FOLDER_MAX_FILES = 500;
/** 遍历的目录项总数上限：超过即停（“文件夹里找不到了”在没遍历完时不报，免得误报）。 */
const WALK_MAX_ENTRIES = 20_000;
/** 跳过清单至多列 200 条（总数另给）。 */
const SKIPPED_LIST_MAX = 200;
/** 与 materials.import 同一上限。 */
const MAX_BYTES = 100 * 1024 * 1024;
/** 导入时解析器认得的格式（与“选择文件”对话框的过滤器同一组，旧版格式另行说明）。 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
const UNSUPPORTED_REASON = "这种文件本机读不了（支持 Word、Excel、PDF、图片、TXT、MD、CSV）";

export interface FolderSkip {
  rel_path: string;
  reason: string;
}
export interface FolderSyncSummary {
  /** 新加入事项的材料份数。 */
  added: number;
  /** 同一位置的文件内容变了、作为新版本加入的份数。 */
  updated: number;
  /** 内容与事项里已有的材料相同（含此前用其他方式添加的），没有重复导入。 */
  unchanged: number;
  skipped: FolderSkip[];
  /** 跳过的总份数（清单至多列 200 条）。 */
  skipped_total: number;
  /** 以前从文件夹导入、现在文件夹里找不到了的位置（只报告，事项材料不删）。 */
  missing_on_disk: string[];
  /** 可导入的文件超过 500 份：按文件夹顺序只处理了前 500 份（之后的同步同样只看前 500 份）。 */
  capped: boolean;
  cap: number;
  /** 这次检查的可导入文件份数。 */
  scanned: number;
  synced_at: string;
}
export interface MatterFolderView {
  name: string;
  root: string;
  linked_at: string | null;
  synced_at: string | null;
}
export interface MaterialSearchHit {
  document_version_id: string;
  filename: string;
  rel_path: string | null;
  /** 解析文字里各词出现的总次数（至多 999）。 */
  hits: number;
  /** 文件名或文件夹位置里含全部词。 */
  name_match: boolean;
  /** 第一处文字命中前后各约 40 字；只有文件名命中时为 null。 */
  snippet: string | null;
}

export interface MatterFolderDeps {
  db: KernelDb;
  /** 本律所工作区目录：它所在的应用数据根目录不能关联（含其中的文件夹），遍历时也跳过。 */
  workspaceDir: string;
  ownDeviceId: string;
  requireMatterAccess(matterId: string, id: Identity): { matter_id: string };
  requireMatterWriter(matterId: string, id: Identity, opts?: { allowClosed?: boolean }): void;
  /** 走正常的导入（materials.import）：解析、密级标志检测、加密保存、审计；声明的 sha256 与内核复算不符即拒收。 */
  importFile(args: { matterId: string; path: string; filename: string; mime: string; sha256: string }, id: Identity): Promise<{ document_version_id: string }>;
  audit(id: Identity, action: string, kind: string, objectId: string, detailHash: string): void;
}

type Handler = (params: any, id: Identity) => unknown | Promise<unknown>;

/** 同一事项同时只跑一次同步（关联也会同步一次）；事项编号全局唯一，模块级集合即可。 */
const syncing = new Set<string>();

export function folderViewOf(m: { folder_root?: string | null; folder_linked_at?: string | null; folder_synced_at?: string | null } | null | undefined): MatterFolderView | null {
  if (!m?.folder_root) return null;
  return { name: basename(m.folder_root) || m.folder_root, root: m.folder_root, linked_at: m.folder_linked_at ?? null, synced_at: m.folder_synced_at ?? null };
}

/** 文件夹里不看的名字：隐藏文件与文件夹、Office 锁文件与临时文件、系统缩略图与目录设置文件。 */
export function ignoredFolderEntry(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("~$")) return true;
  if (/\.tmp$/i.test(name)) return true;
  const lower = name.toLowerCase();
  return lower === "thumbs.db" || lower === "desktop.ini" || lower === "ehthumbs.db";
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}

function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/** 应用数据根目录（工作区目录的上一级：各律所工作区、待激活工作区都在其中）。 */
function appDataRoot(workspaceDir: string): string {
  return realOrSelf(dirname(resolve(workspaceDir)));
}

/** child 是否就是 parent 或在 parent 里面（macOS 与 Windows 不分大小写）。 */
function within(child: string, parent: string): boolean {
  const norm = (x: string) => (process.platform === "win32" || process.platform === "darwin" ? x.toLowerCase() : x);
  const rel = relative(norm(parent), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface WalkResult {
  candidates: { abs: string; rel: string }[];
  present: Set<string>;
  skipped: FolderSkip[];
  /** 没能看全的子文件夹（读不了、层级太深）：其下的材料不报“找不到了”。 */
  blind: string[];
  capped: boolean;
  complete: boolean;
}

function walkFolder(root: string, workspaceDir: string): WalkResult {
  const out: WalkResult = { candidates: [], present: new Set(), skipped: [], blind: [], capped: false, complete: true };
  const appData = appDataRoot(workspaceDir);
  let entries = 0;
  const visit = (abs: string, rel: string, depth: number): void => {
    let list: Dirent[];
    try {
      list = readdirSync(abs, { withFileTypes: true });
    } catch {
      if (!rel) throw validation("读不了关联的文件夹（没有权限或已不存在）：请检查后重新关联");
      out.skipped.push({ rel_path: `${rel}/`, reason: "读不了这个文件夹（没有权限或正被占用），里面的文件没有导入" });
      out.blind.push(rel);
      return;
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of list) {
      if (++entries > WALK_MAX_ENTRIES) {
        out.complete = false;
        return;
      }
      if (ignoredFolderEntry(e.name)) continue;
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      // 符号链接与 Windows 目录联接（junction）不跟随：防止引到文件夹以外的位置。
      // Windows 上 readdir 把一切重解析点（含 OneDrive 按需下载的占位文件）都报成链接：再用 lstat 按重解析标记核一次（复核第 48 批 #3）
      let isLink = e.isSymbolicLink();
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (isLink) {
        try {
          const ls = lstatSync(childAbs);
          isLink = ls.isSymbolicLink();
          isDir = ls.isDirectory();
          isFile = ls.isFile();
        } catch {
          // 读不到就按链接处理（不跟随）
        }
      }
      if (isLink) {
        out.skipped.push({ rel_path: childRel, reason: "这是快捷方式（链接），不跟随：请把真实文件放进文件夹" });
        continue;
      }
      if (isDir) {
        if (within(realOrSelf(childAbs), appData)) continue;
        if (depth + 1 > FOLDER_MAX_DEPTH) {
          out.skipped.push({ rel_path: `${childRel}/`, reason: `文件夹层级太深（超过 ${FOLDER_MAX_DEPTH} 层），里面的文件没有导入` });
          out.blind.push(childRel);
          continue;
        }
        visit(childAbs, childRel, depth + 1);
        if (!out.complete) return;
        continue;
      }
      if (!isFile) continue;
      out.present.add(childRel);
      if (MIME_BY_EXT[extOf(e.name)]) {
        if (out.candidates.length >= FOLDER_MAX_FILES) {
          out.capped = true;
          continue;
        }
        out.candidates.push({ abs: childAbs, rel: childRel });
      } else {
        out.skipped.push({ rel_path: childRel, reason: legacyFormatNotice(e.name) ?? UNSUPPORTED_REASON });
      }
    }
  };
  visit(root, "", 0);
  return out;
}

/** 导入失败的原因（律师能读懂的一句话）；事项层面的错误（结案、无权、事项不存在）不在这里处理，整次同步停下。 */
function skipReason(e: unknown): string {
  const err = e as { code?: string; message?: string; detail?: Record<string, unknown> };
  const msg = String(err?.message ?? "");
  if (err?.code === "classified_material") return `带有国家秘密标志${err.detail?.level ? `（${String(err.detail.level)}★）` : ""}，按规定不能导入，没有保存任何副本：请按涉密载体管理规定线下处理`;
  if (err?.code === "hash_mismatch") return "同步时这份文件正在被改动：请保存、关闭后再同步";
  if (/不是有效的 ZIP|ZIP\/DOCX/i.test(msg)) return "文件已损坏或不完整，打不开：请重新下载或另存一份后再同步";
  if (/[一-鿿]/.test(msg) && (err?.code === "unsupported_file" || err?.code === "validation" || err?.code === "low_quality_scan" || err?.code === "parse_unsafe")) return msg;
  return "读不了这份文件（可能已损坏、设了密码或正被其他程序占用）";
}

/** 事项层面的错误：结案或删除（conflict）、无权（forbidden）、事项不存在（not_found）——整次同步停下，不当成某份文件的问题。 */
function isMatterLevel(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === "conflict" || code === "forbidden" || code === "not_found" || code === "not_activated";
}

const busyError = () => new DomainError("conflict", "正在同步这个事项的案卷文件夹：请等这次同步完成", 409, { folder_sync_busy: true });

/** 这台电脑导入的材料（团队同步收到的材料行在 sync_row_origin 里记着别的设备）。 */
const LOCAL_ORIGIN = `NOT EXISTS (SELECT 1 FROM sync_row_origin o WHERE o.table_name = 'document_versions' AND o.row_pk = dv.document_version_id AND o.origin_device <> ?)`;

async function runSync(d: MatterFolderDeps, matterId: string, id: Identity): Promise<FolderSyncSummary> {
  const { db } = d;
  const m = db.get<{ folder_root: string | null }>(`SELECT folder_root FROM matters WHERE matter_id = ?`, [matterId]);
  const root = m?.folder_root ?? null;
  if (!root) throw validation("这个事项还没有关联案卷文件夹");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(root);
  } catch {
    throw validation("找不到关联的文件夹（可能已移动、改名，或不在这台电脑上）：请重新关联");
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw validation("关联的位置已不是文件夹：请重新关联");

  const walk = walkFolder(root, d.workspaceDir);
  const docs = db.all<{ document_version_id: string; sha256: string; rel_path: string | null; quarantined_at: string | null; local: number }>(
    `SELECT dv.document_version_id, dv.sha256, dv.rel_path, dv.quarantined_at, CASE WHEN ${LOCAL_ORIGIN} THEN 1 ELSE 0 END AS local
       FROM document_versions dv WHERE dv.matter_id = ? ORDER BY dv.created_at ASC, dv.rowid ASC`,
    [d.ownDeviceId, matterId],
  );
  const known = new Set(docs.filter((x) => !x.quarantined_at).map((x) => x.sha256));
  const quarantined = new Set(docs.filter((x) => x.quarantined_at).map((x) => x.sha256));
  /** 每个位置在这台电脑上的最新一版（按导入先后，后者覆盖前者）。 */
  const latestByRel = new Map<string, string>();
  for (const x of docs) if (x.rel_path && x.local === 1 && !x.quarantined_at) latestByRel.set(x.rel_path, x.document_version_id);
  /** 还没对上文件夹位置的本机材料（逐个添加的，或改关联、取消关联后解除了位置的）：内容相同的文件把位置认回来（复核第 48 批 #1）。 */
  const unmappedBySha = new Map<string, string>();
  for (const x of docs) if (!x.rel_path && x.local === 1 && !x.quarantined_at && !unmappedBySha.has(x.sha256)) unmappedBySha.set(x.sha256, x.document_version_id);

  const skipped: FolderSkip[] = [...walk.skipped];
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const c of walk.candidates) {
    let size: number;
    try {
      const s = lstatSync(c.abs);
      if (s.isSymbolicLink() || !s.isFile()) continue;
      size = s.size;
    } catch {
      skipped.push({ rel_path: c.rel, reason: "同步时这份文件被移走或改名了：请再同步一次" });
      continue;
    }
    if (size === 0) {
      skipped.push({ rel_path: c.rel, reason: "空文件（0 字节），没有导入" });
      continue;
    }
    if (size > MAX_BYTES) {
      skipped.push({ rel_path: c.rel, reason: "文件超过 100 MB：请拆分或压缩后再添加" });
      continue;
    }
    let sha: string;
    try {
      sha = sha256Hex(readFileSync(c.abs));
    } catch {
      skipped.push({ rel_path: c.rel, reason: "读不了这份文件（可能没有权限或正被其他程序占用）" });
      continue;
    }
    if (quarantined.has(sha) && !known.has(sha)) {
      skipped.push({ rel_path: c.rel, reason: "这份文件此前因带国家秘密标志已被隔离，不再导入" });
      continue;
    }
    if (known.has(sha)) {
      const adopt = unmappedBySha.get(sha);
      if (adopt && !latestByRel.has(c.rel)) {
        db.run(`UPDATE document_versions SET rel_path = ? WHERE document_version_id = ? AND rel_path IS NULL`, [c.rel, adopt]);
        unmappedBySha.delete(sha);
        latestByRel.set(c.rel, adopt);
      }
      unchanged++;
      continue;
    }
    const prev = latestByRel.get(c.rel) ?? null;
    let docId: string;
    try {
      const name = basename(c.abs);
      const r = await d.importFile({ matterId, path: c.abs, filename: name, mime: MIME_BY_EXT[extOf(name)] ?? "application/octet-stream", sha256: sha }, id);
      docId = r.document_version_id;
    } catch (e) {
      if (isMatterLevel(e)) throw e;
      skipped.push({ rel_path: c.rel, reason: skipReason(e) });
      continue;
    }
    db.run(`UPDATE document_versions SET rel_path = ?, supersedes = ? WHERE document_version_id = ?`, [c.rel, prev, docId]);
    known.add(sha);
    latestByRel.set(c.rel, docId);
    if (prev) updated++;
    else added++;
  }

  // 文件夹里找不到了：只在遍历完整时报告；读不了、层级太深的子文件夹以下不报
  const missing = walk.complete
    ? [...latestByRel.keys()].filter((rel) => !walk.present.has(rel) && !walk.blind.some((b) => rel === b || rel.startsWith(`${b}/`))).sort()
    : [];
  const syncedAt = nowIso();
  db.run(`UPDATE matters SET folder_synced_at = ? WHERE matter_id = ?`, [syncedAt, matterId]);
  const summary: FolderSyncSummary = {
    added,
    updated,
    unchanged,
    skipped: skipped.slice(0, SKIPPED_LIST_MAX),
    skipped_total: skipped.length,
    missing_on_disk: missing,
    // 遍历到上限（条目过多）没走完的，同样算“没有全部导入”（复核第 48 批 #4）
    capped: walk.capped || !walk.complete,
    cap: FOLDER_MAX_FILES,
    scanned: walk.candidates.length,
    synced_at: syncedAt,
  };
  // 审计只记份数（不记路径与文件名）
  d.audit(id, "materials.sync_folder", "matter", matterId, sha256Hex(JSON.stringify({ added, updated, unchanged, skipped: skipped.length, missing: missing.length, capped: walk.capped })));
  return summary;
}

async function withSyncLock<T>(matterId: string, fn: () => Promise<T>): Promise<T> {
  if (syncing.has(matterId)) throw busyError();
  syncing.add(matterId);
  try {
    return await fn();
  } finally {
    syncing.delete(matterId);
  }
}

const LIKE_ESCAPE = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 搜索词：按空白（含全角空格）切分、去重，至多 8 个、每个至多 50 字。 */
export function searchTerms(q: unknown): string[] {
  const s = String(q ?? "").slice(0, 200);
  const terms: string[] = [];
  for (const t of s.split(/\s+/)) {
    const v = t.slice(0, 50);
    if (v && !terms.some((x) => x.toLowerCase() === v.toLowerCase())) terms.push(v);
    if (terms.length >= 8) break;
  }
  return terms;
}

/** 命中处前后各约 40 字（空白折成一个空格；不切开代理对）。 */
export function snippetAround(text: string, at: number, len: number, pad = 40): string {
  let start = Math.max(0, at - pad);
  let end = Math.min(text.length, at + len + pad);
  if (start > 0 && /[\udc00-\udfff]/.test(text[start]!)) start--;
  if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1]!)) end++;
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

export function searchMaterials(db: KernelDb, matterId: string, q: unknown): { terms: string[]; hits: MaterialSearchHit[]; truncated: boolean } {
  const terms = searchTerms(q);
  if (terms.length === 0) return { terms, hits: [], truncated: false };
  // 先在库里按 LIKE 粗筛（只认 ASCII 大小写）；再逐份按不分大小写的正则核实、计数、取片段
  const cond = terms.map(() => `(filename LIKE ? ESCAPE '\\' OR IFNULL(rel_path, '') LIKE ? ESCAPE '\\' OR IFNULL(content, '') LIKE ? ESCAPE '\\')`).join(" AND ");
  const params: unknown[] = [matterId];
  for (const t of terms) {
    const like = `%${LIKE_ESCAPE(t)}%`;
    params.push(like, like, like);
  }
  const rows = db.all<{ document_version_id: string; filename: string; rel_path: string | null; created_at: string; content: string | null }>(
    `WITH docs AS MATERIALIZED (
       SELECT dv.document_version_id, dv.filename, dv.rel_path, dv.created_at,
              (SELECT pt.content FROM parse_versions pv JOIN parse_texts pt ON pt.parse_version_id = pv.parse_version_id
                WHERE pv.document_version_id = dv.document_version_id ORDER BY pv.created_at DESC, pv.rowid DESC LIMIT 1) AS content
         FROM document_versions dv WHERE dv.matter_id = ? AND dv.quarantined_at IS NULL
     )
     SELECT * FROM docs WHERE ${cond} ORDER BY created_at DESC`,
    params,
  );
  const res = terms.map((t) => new RegExp(escapeRe(t), "giu"));
  const hits: (MaterialSearchHit & { created_at: string })[] = [];
  for (const r of rows) {
    const name = `${r.filename}\n${r.rel_path ?? ""}`;
    const text = r.content ?? "";
    let total = 0;
    let first: { at: number; len: number } | null = null;
    let all = true;
    let nameAll = true;
    for (const re of res) {
      re.lastIndex = 0;
      const inName = re.test(name);
      re.lastIndex = 0;
      let n = 0;
      for (const m of text.matchAll(re)) {
        if (n === 0 && (first === null || m.index! < first.at)) first = { at: m.index!, len: m[0].length };
        if (++n >= 999) break;
      }
      if (!inName) nameAll = false;
      if (!inName && n === 0) all = false;
      total += n;
    }
    if (!all) continue;
    hits.push({
      document_version_id: r.document_version_id,
      filename: r.filename,
      rel_path: r.rel_path,
      hits: Math.min(total, 999),
      name_match: nameAll,
      snippet: first ? snippetAround(text, first.at, first.len) : null,
      created_at: r.created_at,
    });
  }
  hits.sort((a, b) => Number(b.name_match) - Number(a.name_match) || b.hits - a.hits || (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return { terms, hits: hits.slice(0, 50).map(({ created_at: _c, ...h }) => h), truncated: hits.length > 50 };
}

/** materials.link_folder / sync_folder / unlink_folder / search（注册在 api/index.ts 的材料一节）。 */
export function createMatterFolderApi(d: MatterFolderDeps): Record<string, Handler> {
  const { db } = d;
  /** 解除这台电脑导入的材料与文件夹位置的对应（材料都留在事项里；别的设备导入的不动）。 */
  const detachFolderPaths = (matterId: string) =>
    db.run(`UPDATE document_versions AS dv SET rel_path = NULL WHERE dv.matter_id = ? AND dv.rel_path IS NOT NULL AND ${LOCAL_ORIGIN}`, [matterId, d.ownDeviceId]);
  return {
    /** 关联本机的案卷文件夹（桌面客户端由主进程把对话框选定的文件夹句柄换成 path），随即同步一次。可以改关联到另一个文件夹。 */
    "materials.link_folder": async (p, id) => {
      const matterId = d.requireMatterAccess(String(p?.matter_id ?? ""), id).matter_id;
      d.requireMatterWriter(matterId, id);
      const raw = String(p?.path ?? "");
      if (!raw) throw validation("需要选择一个文件夹");
      if (!isAbsolute(raw)) throw validation("文件夹位置须为完整路径");
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(raw);
      } catch {
        throw validation("找不到这个文件夹");
      }
      if (st.isSymbolicLink()) throw validation("这是快捷方式（链接）：请选择真实的文件夹");
      if (!st.isDirectory()) throw validation("选的不是文件夹");
      const root = realOrSelf(raw);
      if (within(root, appDataRoot(d.workspaceDir))) throw validation("不能关联 Kimi Work 自己的数据目录：请选择存放案卷的文件夹");
      try {
        readdirSync(root);
      } catch {
        throw validation("读不了这个文件夹（没有权限）：请换一个文件夹，或请 IT 开通读取权限");
      }
      return withSyncLock(matterId, async () => {
        const now = nowIso();
        const prevRoot = db.get<{ folder_root: string | null }>(`SELECT folder_root FROM matters WHERE matter_id = ?`, [matterId])?.folder_root ?? null;
        // 改关联到另一个位置：解除本机材料与旧位置的对应（否则同名文件会被当成新版本、旧文件夹的文件每次都报“找不到”）。
        // 内容没变的文件在随后的同步里按内容把新位置认回来，所以只是挪了位置的同一个案卷不会丢掉版本关系（复核第 48 批 #1）
        if (prevRoot !== root) detachFolderPaths(matterId);
        db.run(`UPDATE matters SET folder_root = ?, folder_linked_at = ?, folder_synced_at = NULL WHERE matter_id = ?`, [root, now, matterId]);
        // 审计只记路径的哈希（路径里常有当事人名称）
        d.audit(id, "materials.link_folder", "matter", matterId, sha256Hex(root));
        const summary = await runSync(d, matterId, id);
        return { folder: folderViewOf(db.get(`SELECT folder_root, folder_linked_at, folder_synced_at FROM matters WHERE matter_id = ?`, [matterId])), ...summary };
      });
    },

    /** 手动同步：导入新增、改过的文件；内容相同的不重复导入；文件夹里删掉的只报告。 */
    "materials.sync_folder": async (p, id) => {
      const matterId = d.requireMatterAccess(String(p?.matter_id ?? ""), id).matter_id;
      d.requireMatterWriter(matterId, id);
      return withSyncLock(matterId, async () => {
        const summary = await runSync(d, matterId, id);
        return { folder: folderViewOf(db.get(`SELECT folder_root, folder_linked_at, folder_synced_at FROM matters WHERE matter_id = ?`, [matterId])), ...summary };
      });
    },

    /** 取消关联：只清除这台电脑记下的文件夹位置，已导入的材料都留在事项里。已结案的事项也可以取消关联。 */
    "materials.unlink_folder": (p, id) => {
      const matterId = d.requireMatterAccess(String(p?.matter_id ?? ""), id).matter_id;
      d.requireMatterWriter(matterId, id, { allowClosed: true });
      if (syncing.has(matterId)) throw busyError();
      const old = db.get<{ folder_root: string | null }>(`SELECT folder_root FROM matters WHERE matter_id = ?`, [matterId])?.folder_root ?? null;
      if (!old) return { folder: null };
      db.run(`UPDATE matters SET folder_root = NULL, folder_linked_at = NULL, folder_synced_at = NULL WHERE matter_id = ?`, [matterId]);
      detachFolderPaths(matterId);
      d.audit(id, "materials.unlink_folder", "matter", matterId, sha256Hex(old));
      return { folder: null };
    },

    /** 在本事项的材料里搜索（文件名、文件夹位置、解析文字）；已隔离的材料不在其中。只在本机，不审计、不外发。 */
    "materials.search": (p, id) => {
      const matterId = d.requireMatterAccess(String(p?.matter_id ?? ""), id).matter_id;
      return searchMaterials(db, matterId, p?.q);
    },
  };
}
