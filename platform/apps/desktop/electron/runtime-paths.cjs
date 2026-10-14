/**
 * 随包运行时定位（安装包形态；收敛偏离 D-05、D-23）。
 *
 * 安装包把需要独立 Node 运行的组件放在 resources/runtime/（不进 asar——随包 node.exe 读不了 asar）：
 *   node/node.exe（Windows）或 node/bin/node（macOS 本机验证）  随包 Node 26，摘要与版本锁定
 *   （审计 S3 第 2 步起不再随包原生 ripgrep：Grep/Glob 由 Agent 宿主内检索完成）
 *   w/                                                          W 执行域运行时（supervisor.mjs、worker.mjs、node_modules/just-bash）
 *   kap-host/main.mjs、kap-host/search-worker.mjs                Agent 宿主（kap-server 私有嵌入）与宿主内检索 worker
 *   egress-gate/main.mjs                                        出站闸门（唯一出口）
 *   runtime-manifest.json                                       由 scripts/build-runtime.mjs 生成：各文件相对路径、sha256、Node 版本
 *
 * 规则：安装包形态下任一项缺失或摘要不符即“运行时损坏”，主进程不拉起内核、显示修复指引——
 * 绝不回落到律师电脑 PATH 上的 node（那会让执行域与闸门运行在未经核验的解释器里）。
 * 本模块无 Electron 依赖，可单测。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MANIFEST = "runtime-manifest.json";

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
 */
function resolveBundledRuntime(runtimeRoot, { verifyDigests = true } = {}) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, MANIFEST), "utf8"));
  } catch (e) {
    return { ok: false, problems: [`缺少或无法读取运行时清单（${MANIFEST}）`] };
  }
  if (!manifest || manifest.format !== "kwl-runtime/1") return { ok: false, problems: ["运行时清单格式不符"] };
  const files = {};
  for (const key of ["node", "kapHost", "kapSearchWorker", "gate", "wSupervisor", "wWorker", "jbEntry"]) {
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
    if (verifyDigests && ent.sha256 && sha256File(abs) !== ent.sha256) problems.push(`摘要不符：${ent.path}`);
    files[key] = abs;
  }
  const wDir = inside(runtimeRoot, manifest.wDir ?? "");
  if (!wDir) problems.push("清单缺少 W 运行时目录");
  if (typeof manifest.nodeVersion !== "string" || !/^v\d+\.\d+\.\d+$/.test(manifest.nodeVersion)) problems.push("清单缺少锁定的 Node 版本");
  if (problems.length) return { ok: false, problems };
  const nodeSha = manifest.files.node.sha256;
  return {
    ok: true,
    manifest,
    env: {
      KWL_AGENT_HOST_NODE: files.node,
      KWL_GATE_NODE: files.node,
      ...(nodeSha ? { KWL_GATE_NODE_SHA256: nodeSha, KWL_RUNTIME_NODE_SHA256: nodeSha } : {}),
      KWL_RUNTIME_NODE_VERSION: manifest.nodeVersion,
      KWL_W_RUNTIME_DIR: wDir,
      ZR_KAP_HOST_ENTRY: files.kapHost,
      ZR_EGRESS_GATE_ENTRY: files.gate,
    },
  };
}

module.exports = { resolveBundledRuntime, sha256File, MANIFEST };
