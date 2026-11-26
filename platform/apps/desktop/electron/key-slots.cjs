"use strict";
/**
 * 数据库密钥按账号档案分格保存（第 68 批，D-294：同一台电脑多个账号）。无 Electron 依赖，可单测。
 *
 * 此前一台电脑只有一把数据库主密钥（userData/ledger-key），所有工作区共用——换账号时若“从备份恢复”采用了旧电脑的密钥，
 * 这台电脑上别的账号的数据就再也打不开；各账号的数据在密码学上也没有分开。现在每个档案一把：
 * - 第一个档案（以及升级前的工作区）沿用 ledger-key（激活记录里没有 key_slot）；
 * - 这台电脑上已有档案时，待激活另起一把 ledger-key.pending；激活后激活记录带 key_slot = 工作区目录名，主进程下次启动时把
 *   ledger-key.pending 改名为 ledger-key.p.<目录名> 归这个档案（“p.” 前缀：律所标识由邮箱前缀生成，可能恰好叫 legacy、pending——
 *   档案的文件名与两把保留的文件名永不重名；安全复核 K-1）；
 * - 内核每次只拿到当前档案的那一把：别的档案的账本、密钥文件、会话它都解不开。
 *
 * 只读文件名与激活记录（明文、无秘密），不碰密钥内容（包裹与解封仍在 secret-store.cjs）。
 */
const fs = require("node:fs");
const path = require("node:path");

/** 与内核 config.ts WORKSPACE_NAME_PATTERN 同一规则。 */
const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,52})?$/;
const FIRM_SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const PENDING_WORKSPACE = "pending-activation";
const PROFILE_FILE = "profile.json";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 激活记录里的工作区与密钥格（只核对这两项与律所标识；其余由内核核对）。不合规返回 null。 */
function slotOfRecord(a) {
  if (!a || typeof a !== "object" || a.v !== 1 || typeof a.firm_slug !== "string" || !FIRM_SLUG.test(a.firm_slug)) return null;
  const ws = a.workspace === undefined ? a.firm_slug : a.workspace;
  if (typeof ws !== "string" || !WORKSPACE_NAME.test(ws) || ws === PENDING_WORKSPACE || !(ws === a.firm_slug || ws.startsWith(`${a.firm_slug}.`))) return null;
  if (a.key_slot === undefined) return { workspace: ws, slot: "legacy" };
  if (typeof a.key_slot !== "string" || a.key_slot !== ws) return null;
  // 档案的格用“p:<目录名>”表示（与保留的 legacy / pending 两格分开，目录名叫 legacy、pending 也不混）
  return { workspace: ws, slot: `p:${ws}` };
}

/** 本机除待激活占位以外，有没有别的工作区（带档案记录或账本）。 */
function hasOtherWorkspaces(dataDir) {
  try {
    return fs
      .readdirSync(dataDir, { withFileTypes: true })
      .some((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== PENDING_WORKSPACE && (fs.existsSync(path.join(dataDir, e.name, PROFILE_FILE)) || fs.existsSync(path.join(dataDir, e.name, "ledger.db"))));
  } catch {
    return false;
  }
}

function keyFileOf(userDataDir, slot) {
  if (slot === "legacy") return path.join(userDataDir, "ledger-key");
  if (slot === "pending") return path.join(userDataDir, "ledger-key.pending");
  if (typeof slot === "string" && slot.startsWith("p:") && WORKSPACE_NAME.test(slot.slice(2))) return path.join(userDataDir, `ledger-key.p.${slot.slice(2)}`);
  throw new Error("key_slot_invalid");
}

/**
 * 这次启动内核用哪把密钥。返回 { kind: "legacy"|"pending"|"profile", slot, file, workspace|null, adopted, freshPending }：
 * - 有激活记录（或从备份恢复的待生效记录）：按它的 key_slot；档案自己的密钥文件还不存在而 pending 存在 → 改名归它（adopted）；
 * - 没有：待激活。别的工作区存在 → pending（freshPending = 这把是新起的：旧的待激活占位工作区由旧密钥加密，须先清掉）；否则 legacy。
 * 激活记录读不了或不合规按“没有”处理（与内核一致：以待激活启动）。
 */
function planKeySlot({ dataDir, userDataDir, now = Date.now() }) {
  const live = slotOfRecord(readJson(path.join(dataDir, "activation.json")));
  // 从备份恢复的待生效记录（activation.pending.json）：只在没有激活记录时（与内核 reconcilePendingRestore 一致）
  const restoring = live ? null : slotOfRecord(readJson(path.join(dataDir, "activation.pending.json")));
  const act = live ?? restoring;
  if (act) {
    const file = keyFileOf(userDataDir, act.slot);
    const pending = keyFileOf(userDataDir, "pending");
    let adopted = false;
    if (act.slot !== "legacy" && fs.existsSync(pending)) {
      // 归属判定（不猜时间先后）：
      // - 档案自己的密钥还不存在 → 待激活那把就是它的（新开通、新登记、恢复后采用的旧主密钥都写在 pending 里）；
      // - 已存在但工作区里还没有账本（从未按这个档案启动过：同名的残留密钥）或正在从备份恢复 → 同样归 pending，残留的那把改名留档；
      // - 档案已有账本且自己的密钥在 → 用它自己的（pending 是别的待激活尝试留下的，不动）。
      const fresh = !fs.existsSync(file);
      const unused = !fresh && (restoring !== null || !fs.existsSync(path.join(dataDir, act.workspace, "ledger.db")));
      if (fresh || unused) {
        if (unused) fs.renameSync(file, `${file}.stale-${new Date(now).toISOString().replace(/[:.]/g, "-")}`);
        fs.renameSync(pending, file);
        adopted = true;
      }
    }
    return { kind: act.slot === "legacy" ? "legacy" : "profile", slot: act.slot, file, workspace: act.workspace, adopted, freshPending: false };
  }
  if (hasOtherWorkspaces(dataDir)) {
    const file = keyFileOf(userDataDir, "pending");
    return { kind: "pending", slot: "pending", file, workspace: null, adopted: false, freshPending: !fs.existsSync(file) };
  }
  return { kind: "legacy", slot: "legacy", file: keyFileOf(userDataDir, "legacy"), workspace: null, adopted: false, freshPending: false };
}

/**
 * 主密钥解封失败时移到一边的范围（unreadable-data.cjs）：这台电脑上有别的档案时只移当前这一个（它的工作区；待激活则是占位工作区），
 * 别的账号的数据不动；没有别的档案时与以前相同（null = 全部）。
 */
function quarantineScope(plan, dataDir) {
  if (plan.kind === "pending") return [PENDING_WORKSPACE];
  // 档案的数据只在它自己的工作区（待激活占位工作区用的是另一把密钥，不随它移）
  if (plan.workspace && hasOtherWorkspacesExcept(dataDir, plan.workspace)) return [plan.workspace];
  return null;
}

function hasOtherWorkspacesExcept(dataDir, ws) {
  try {
    return fs
      .readdirSync(dataDir, { withFileTypes: true })
      .some((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== PENDING_WORKSPACE && e.name !== ws && (fs.existsSync(path.join(dataDir, e.name, PROFILE_FILE)) || fs.existsSync(path.join(dataDir, e.name, "ledger.db"))));
  } catch {
    return false;
  }
}

/** 切换账号交接的形状核对（主进程只转交、不读内容；内核再按 profiles.ts 逐项核对）。 */
function validHandoffShape(h) {
  return !!h && typeof h === "object" && h.v === 1 && (h.kind === "session" || h.kind === "auth");
}

module.exports = { planKeySlot, quarantineScope, keyFileOf, slotOfRecord, hasOtherWorkspaces, validHandoffShape, PENDING_WORKSPACE };
