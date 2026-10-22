/**
 * 主进程文件对话框与一次性句柄（v9.2 §3.7；调研 Y5 P1-4、W3、W7、F6）：
 * - 选择材料与保存位置都由主进程弹系统对话框，带 dontAddToRecent（不进“最近使用”与跳转列表）；
 * - 渲染进程只拿到不透明的一次性句柄（随机 128 位、10 分钟有效、用一次即作废）与文件名，拿不到、也不能指定路径；
 * - 主进程转发内核调用时把句柄换成路径：读取类方法（导入/挂载）换 path，导出类方法（成果、诊断包、结案归档）换 save_path，
 *   渲染进程自己带来的 save_path 一律剥掉——内核只往律师在对话框里选定的位置写；
 * - 保存目标在 OneDrive / iCloud 等同步文件夹或网络位置时给出风险标记，界面先说明“会以明文同步到云端”再写。
 * 纯函数部分可单测（test/file-dialogs.test.ts）。
 */
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const HANDLE_TTL_MS = 10 * 60_000;
/** 读取类方法：一次性句柄换成内核参数名（复核 S5A-01）。 */
const OPEN_METHODS = new Map([
  ["materials.import", "path"],
  ["materials.mount", "path"],
  ["recovery.import_device", "file"],
  ["eval.open", "path"],
  // 第 14 批：试解恢复包、从备份恢复（恢复包文件）
  ["recovery.verify_package", "file"],
  ["onboarding.restore", "file"],
  // 第 15 批 B-4：上传律所 Word 模板
  ["doc_style.set_template", "file"],
]);
/** 选文件夹类方法（第 14 批）：文件夹句柄换成内核参数名。 */
const FOLDER_METHODS = new Map([
  ["backup.configure", "dir"],
  ["onboarding.restore", "dir"],
]);
/** 写出类方法：保存句柄换成内核参数名。 */
const SAVE_METHODS = new Map([
  ["artifacts.download", "save_path"],
  ["diagnostics.export", "save_path"],
  ["matters.archive", "save_path"],
  ["recovery.export_device", "path"],
  ["eval.save_work", "save_path"],
  ["eval.save_report", "save_path"],
  ["control_plane.audit_export", "save_path"],
  // 第 14 批：恢复包
  ["recovery.create_package", "path"],
  // 第 15 批 B-4：文书版式样张
  ["doc_style.sample", "save_path"],
]);
/** 渲染进程带来的一切路径类参数一律剥掉（复核 S5A-01：否则内核会按页面给的路径读写，含 UNC 网络路径引起的 SMB 外连）。 */
const PATH_KEYS = ["path", "file", "save_path", "share_dir", "dir", "out", "target"];

const MIME = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};
function mimeOf(name) {
  return MIME[path.extname(String(name)).toLowerCase()] ?? "application/octet-stream";
}

function createHandleStore(now = () => Date.now()) {
  const map = new Map();
  const sweep = () => {
    const t = now();
    for (const [k, v] of map) if (v.expires < t) map.delete(k);
  };
  return {
    issue(kind, p) {
      sweep();
      const handle = randomBytes(16).toString("hex");
      map.set(handle, { kind, path: p, expires: now() + HANDLE_TTL_MS });
      return handle;
    },
    /** 取出并作废；类型不符或过期返回 null。 */
    take(handle, kind) {
      sweep();
      if (typeof handle !== "string" || !/^[0-9a-f]{32}$/.test(handle)) return null;
      const v = map.get(handle);
      if (!v || v.kind !== kind) return null;
      map.delete(handle);
      return v.path;
    },
    size: () => map.size,
  };
}

/**
 * 保存目标的同步/网络风险（只看路径与环境变量，不访问磁盘）：
 * onedrive = OneDrive（含“已知文件夹移动”后的文档/桌面）；cloud = macOS iCloud 云盘与“云存储”文件夹；network = UNC 网络路径。
 */
function classifySaveTarget(p, env = process.env, platform = process.platform) {
  const s = String(p);
  const norm = (x) => (platform === "win32" ? x.replace(/\//g, "\\").toLowerCase() : x);
  const target = norm(s);
  for (const k of ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"]) {
    const root = env[k];
    if (root && root.length > 3) {
      const r = norm(root).replace(/[\\/]+$/, "");
      if (target === r || target.startsWith(r + (platform === "win32" ? "\\" : "/"))) return "onedrive";
    }
  }
  if (/[\\/]onedrive(?:\s*-\s*[^\\/]+)?[\\/]/i.test(s)) return "onedrive";
  if (/[\\/]Library[\\/](?:Mobile Documents|CloudStorage)[\\/]/.test(s)) return "cloud";
  // 常见同步盘（复核 S5A-05）：Dropbox、Google Drive、Box、iCloud（Windows）、坚果云、百度网盘
  if (/[\\/](?:Dropbox|Google Drive|GoogleDrive|My Drive|Box|Box Sync|iCloudDrive|iCloud Drive|Nutstore|我的坚果云|坚果云|BaiduNetdisk|百度网盘)(?:[\\/]|$)/i.test(s)) return "cloud";
  if (/^\\\\(?![?.]\\)/.test(s) || /^\\\\\?\\UNC\\/i.test(s)) return "network";
  return null;
}

/** 保存目标是否落在本应用的数据目录里（数据根、Electron userData；复核 S5A-04）——大小写不敏感比较。 */
function insideAppData(target, roots, platform = process.platform) {
  const P = platform === "win32" ? path.win32 : path.posix;
  const norm = (x) => (platform === "win32" || platform === "darwin" ? String(x).toLowerCase() : String(x));
  return roots.filter(Boolean).some((r) => {
    const rel = P.relative(norm(r), norm(target));
    return rel === "" || (!rel.startsWith("..") && !P.isAbsolute(rel));
  });
}

/** 渲染进程给的文件名只取基本名、去掉控制字符与路径分隔符。 */
function safeSuggestedName(name) {
  const base = path.basename(String(name ?? "")).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 120).trim();
  return base || "导出文件";
}

/**
 * 转发内核调用前换句柄：读取类方法 file_handle → path（并给出 mime）；导出类方法 save_handle → save_path。
 * 渲染进程自带的 save_path 一律剥掉；句柄无效即返回错误（不转发）。
 */
function resolveFileParams(method, params, store) {
  const p = params && typeof params === "object" && !Array.isArray(params) ? { ...params } : {};
  for (const k of PATH_KEYS) delete p[k];
  const saveKey = SAVE_METHODS.get(method);
  if (saveKey && p.save_handle !== undefined) {
    const target = store.take(p.save_handle, "save");
    if (!target) return { error: { code: "validation", message: "保存位置已失效，请重新选择" } };
    p[saveKey] = target;
  }
  delete p.save_handle;
  const openKey = OPEN_METHODS.get(method);
  if (openKey && p.file_handle !== undefined) {
    const src = store.take(p.file_handle, "open");
    if (!src) return { error: { code: "validation", message: "所选文件已失效，请重新选择" } };
    p[openKey] = src;
    if (openKey === "path") {
      if (!p.filename) p.filename = path.basename(src);
      if (!p.mime) p.mime = mimeOf(src);
    }
  }
  delete p.file_handle;
  const folderKey = FOLDER_METHODS.get(method);
  if (folderKey && p.folder_handle !== undefined) {
    const dir = store.take(p.folder_handle, "folder");
    if (!dir) return { error: { code: "validation", message: "所选文件夹已失效，请重新选择" } };
    p[folderKey] = dir;
  }
  delete p.folder_handle;
  return { params: p };
}

/** 拖放进来的文件（preload 经 webUtils 从真实的 File 取得路径）：网络路径一律不收（不由页面触发 SMB 连接）。 */
function acceptDroppedPath(p) {
  if (typeof p !== "string" || !path.isAbsolute(p)) return false;
  if (/^\\\\/.test(p) || /^\/\//.test(p)) return false;
  return true;
}

/**
 * 在 Word / WPS 中打开刚保存的成果（v9.4 第 21 批；主文 §3.2“Word / WPS 打开并定位”）：只对律师在对话框里选定位置、内核已写成功的
 * Word / Excel / PDF 成果发一次性“打开”句柄——不在临时目录另写明文副本，打开的就是律师自己保存的那份。纯函数：返回可打开的路径或 null。
 */
const OPENABLE = /\.(docx|xlsx|pdf)$/i;
function openableSaved(method, params, reply) {
  if (method !== "artifacts.download") return null;
  const p = params && typeof params.save_path === "string" ? params.save_path : null;
  if (!p || !OPENABLE.test(p)) return null;
  if (!reply || reply.ok !== true || !reply.result || reply.result.saved !== true) return null;
  return p;
}

module.exports = { insideAppData, createHandleStore, classifySaveTarget, resolveFileParams, acceptDroppedPath, safeSuggestedName, mimeOf, openableSaved, OPENABLE, HANDLE_TTL_MS, OPEN_METHODS, SAVE_METHODS, PATH_KEYS };
