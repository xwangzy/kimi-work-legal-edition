/**
 * 随包运行时定位（安装包形态；收敛偏离 D-05、D-23）。
 *
 * 安装包把需要独立 Node 运行的组件放在 resources/runtime/（不进 asar——随包 node.exe 读不了 asar）：
 *   node/node.exe（Windows）或 node/bin/node（macOS 本机验证）  随包 Node 26，摘要与版本锁定
 *   （审计 S3 第 2 步起不再随包原生 ripgrep：Grep/Glob 由 Agent 宿主内检索完成）
 *   w/                                                          W 执行域运行时（supervisor.mjs、worker.mjs、node_modules/just-bash）
 *   kap-host/main.mjs、kap-host/search-worker.mjs                Agent 宿主（kap-server 私有嵌入）与宿主内检索 worker
 *   egress-gate/main.mjs                                        出站闸门（唯一出口）
 *   parse/parse-worker.cjs + parse/node_modules                 隔离解析进程（W6：随包 Node 运行，不借 Electron 自身 fork）
 *   ocr-models/                                                 本机 OCR 模型（PP-OCRv5 mobile）
 *   runtime-manifest.json                                       由 scripts/build-runtime.mjs 生成：各文件相对路径、sha256、Node 版本
 *
 * 规则：安装包形态下任一项缺失或摘要不符即“运行时损坏”，主进程不拉起内核、显示修复指引；清单列出运行时目录的全部文件，
 * 启动时核对入口摘要、全部文件的存在与大小、清单外文件与 asar.unpacked 原生模块摘要，后台再核对全部文件摘要（复核 B4-A01）——
 * 绝不回落到律师电脑 PATH 上的 node（那会让执行域与闸门运行在未经核验的解释器里）。
 * 本模块无 Electron 依赖，可单测。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MANIFEST = "runtime-manifest.json";
/** 清单必须列出且摘要一致的文件（W6 起含解析进程、onnxruntime 原生绑定与 OCR 模型）。 */
const REQUIRED_FILES = ["node", "nodeEgress", "nodeHost", "nodeParse", "kapHost", "kapSearchWorker", "gate", "wSupervisor", "wWorker", "jbEntry", "parseWorker", "ortBinding", "ocrDet", "ocrRec", "ocrDict"];

function sha256File(file) {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

/** 相对路径只许在运行时目录之内（清单被篡改时不得指向目录外）。 */
function inside(root, rel) {
  if (typeof rel !== "string" || rel.length === 0 || path.isAbsolute(rel)) return null;
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (r.startsWith("..") || path.isAbsolute(r)) return null;
  return abs;
}

/**
 * 读取并核验随包运行时。返回 { ok: true, env, manifest } 或 { ok: false, problems }。
 * verifyDigests=false 只核对存在性（W 与闸门在拉起时各自再按摘要核验 Node）。
 *
 * trustedManifestFile（安装包形态必传）：期望摘要以 asar 内的清单副本为准——resources/runtime 在 asar 之外，
 * 其中的清单与被核对的文件同处一地，能改文件的人也能改清单；asar 的完整性由 Electron 熔断按可执行文件内嵌哈希校验，
 * 可执行文件本身有代码签名。盘上清单此时只作诊断，不参与放行。
 */
function resolveBundledRuntime(runtimeRoot, { verifyDigests = true, trustedManifestFile = null, unpackedRoot = null } = {}) {
  const problems = [];
  let manifest;
  const manifestFile = trustedManifestFile ?? path.join(runtimeRoot, MANIFEST);
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (e) {
    return { ok: false, problems: [`缺少或无法读取运行时清单（${trustedManifestFile ? "应用包内副本" : MANIFEST}）`] };
  }
  if (!manifest || manifest.format !== "kwl-runtime/1") return { ok: false, problems: ["运行时清单格式不符"] };
  const files = {};
  for (const key of REQUIRED_FILES) {
    const ent = manifest.files?.[key];
    const abs = ent ? inside(runtimeRoot, ent.path) : null;
    if (!abs) {
      problems.push(`清单缺少 ${key}`);
      continue;
    }
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      problems.push(`缺少文件：${ent.path}`);
      continue;
    }
    if (!st.isFile()) {
      problems.push(`不是文件：${ent.path}`);
      continue;
    }
    // 安装包形态（有 asar 内清单）缺摘要即判损坏，不跳过比对（复核 B4-A01）
    if (trustedManifestFile && typeof ent.sha256 !== "string") problems.push(`清单项缺少摘要：${key}`);
    else if (verifyDigests && ent.sha256 && sha256File(abs) !== ent.sha256) problems.push(`摘要不符：${ent.path}`);
    files[key] = abs;
  }
  if (trustedManifestFile) problems.push(...treeProblems(runtimeRoot, manifest), ...unpackedProblems(unpackedRoot, manifest));
  const wDir = inside(runtimeRoot, manifest.wDir ?? "");
  if (!wDir) problems.push("清单缺少 W 运行时目录");
  if (typeof manifest.nodeVersion !== "string" || !/^v\d+\.\d+\.\d+$/.test(manifest.nodeVersion)) problems.push("清单缺少锁定的 Node 版本");
  if (problems.length) return { ok: false, problems };
  const nodeSha = manifest.files.node.sha256;
  return {
    ok: true,
    manifest,
    env: {
      // 各子进程用各自文件名的随包 Node（Y5 P1-5）：任务管理器、防火墙规则与 WER 排除按程序名区分
      KWL_AGENT_HOST_NODE: files.nodeHost,
      KWL_GATE_NODE: files.nodeEgress,
      ...(nodeSha ? { KWL_GATE_NODE_SHA256: nodeSha, KWL_RUNTIME_NODE_SHA256: nodeSha } : {}),
      KWL_RUNTIME_NODE_VERSION: manifest.nodeVersion,
      KWL_W_RUNTIME_DIR: wDir,
      ZR_KAP_HOST_ENTRY: files.kapHost,
      ZR_EGRESS_GATE_ENTRY: files.gate,
      KWL_PARSE_NODE: files.nodeParse,
      KWL_PARSE_WORKER_ENTRY: files.parseWorker,
      ZR_OCR_MODEL_DIR: path.dirname(files.ocrDet),
    },
  };
}

/**
 * 全部文件的存在性与大小（同步、只做 stat，启动时执行；复核 B4-A01）：清单列出的每个文件都在且大小一致，
 * 运行时目录里不得有清单外的文件。摘要比对见 verifyRuntimeDigests（后台执行）。
 */
function treeProblems(runtimeRoot, manifest) {
  const out = [];
  const all = Array.isArray(manifest.all) ? manifest.all : null;
  if (!all) return ["运行时清单缺少全部文件列表"];
  const listed = new Set();
  for (const ent of all) {
    const abs = ent && typeof ent.sha256 === "string" && Number.isSafeInteger(ent.size) ? inside(runtimeRoot, ent.path) : null;
    if (!abs) {
      out.push(`清单项不合法：${String(ent && ent.path).slice(0, 80)}`);
      continue;
    }
    listed.add(path.normalize(abs));
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      out.push(`缺少文件：${ent.path}`);
      continue;
    }
    if (!st.isFile() || st.size !== ent.size) out.push(`文件大小不符：${ent.path}`);
  }
  const manifestOnDisk = path.normalize(path.join(runtimeRoot, MANIFEST));
  (function walk(dir) {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const abs = path.normalize(path.join(dir, d.name));
      if (d.isDirectory()) walk(abs);
      else if (abs !== manifestOnDisk && !listed.has(abs)) out.push(`清单外的文件：${path.relative(runtimeRoot, abs)}`);
    }
  })(runtimeRoot);
  return out.slice(0, 20);
}

/** asar.unpacked 里的原生模块（内核进程装载；asar 完整性不覆盖 unpacked）：启动时同步核对摘要。 */
function unpackedProblems(unpackedRoot, manifest) {
  const list = Array.isArray(manifest.unpacked) ? manifest.unpacked : [];
  if (!unpackedRoot) return list.length ? ["未给出 asar.unpacked 目录"] : [];
  const out = [];
  for (const ent of list) {
    const abs = ent && typeof ent.sha256 === "string" ? inside(unpackedRoot, ent.path) : null;
    if (!abs) {
      out.push(`清单项不合法：${String(ent && ent.path).slice(0, 80)}`);
      continue;
    }
    try {
      if (sha256File(abs) !== ent.sha256) out.push(`摘要不符：${ent.path}`);
    } catch {
      out.push(`缺少文件：${ent.path}`);
    }
  }
  return out;
}

/**
 * 全部文件的摘要比对（异步、逐个读取并让出事件循环；启动后后台执行，复核 B4-A01）。返回问题列表（空 = 通过）。
 * 启动时同步核对的是入口文件摘要与全部文件的存在性和大小；这里补上依赖闭包、原生模块、wasm 与模型的内容比对。
 */
async function verifyRuntimeDigests(runtimeRoot, manifest) {
  const out = [];
  for (const ent of Array.isArray(manifest.all) ? manifest.all : []) {
    const abs = ent && typeof ent.sha256 === "string" ? inside(runtimeRoot, ent.path) : null;
    if (!abs) {
      out.push(`清单项不合法：${String(ent && ent.path).slice(0, 80)}`);
      continue;
    }
    try {
      const h = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(abs, { highWaterMark: 1 << 20 })) h.update(chunk);
      if (h.digest("hex") !== ent.sha256) out.push(`摘要不符：${ent.path}`);
    } catch {
      out.push(`缺少文件：${ent.path}`);
    }
    if (out.length >= 20) break;
  }
  return out;
}

module.exports = { resolveBundledRuntime, verifyRuntimeDigests, sha256File, MANIFEST, REQUIRED_FILES };
