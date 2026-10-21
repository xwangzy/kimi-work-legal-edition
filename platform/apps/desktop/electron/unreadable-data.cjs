"use strict";
/**
 * 本机数据打不开时“移到一边、从备份恢复”（v9.3 主文 §9 第 7 项；第 14 批复核 R2B-10）。无 Electron 依赖，可单测。
 *
 * 同一 Windows 账户上 DPAPI 解封失败（管理员重置了本地账户密码、系统重装后还原了用户目录、.electron 目录被清理）时，
 * 原来的数据库主密钥找不回来，本机所有工作区都打不开；而“从备份恢复”只在待激活模式开放（要求数据根下没有 activation.json）。
 * 这里只做**改名**、不删除：激活记录、入组与恢复的中间记录、每个有账本的工作区、最后是 DPAPI 包裹的主密钥文件，
 * 一律改名到 `<数据根>/.unreadable-<时刻>/`（以点开头：不会与律所标识重名，旧工作区检测也不认它）。主密钥文件最后移：
 * 中途失败时它还在，下次启动仍会走到同一个对话框、再移一次剩下的；不会出现“新主密钥 + 旧激活记录”打不开的半截状态。
 *
 * 返回 { ok: true, dir, moved: string[] } 或 { ok: false, code: "exists" | "cross_device" | "move_failed", moved }。
 */
const fs = require("node:fs");
const path = require("node:path");

/** 数据根下与身份、入组、恢复有关的记录文件（与内核 config.ts / services/onboarding.ts 同名）。 */
const RECORD_FILES = ["activation.json", "activation.pending.json", "onboarding-failed.json"];
/** 律所标识与工作区目录名同一规则（config.ts SLUG_PATTERN）。 */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;
const PREFIX = ".unreadable-";

function stamp(now) {
  // 2026-10-21T08-30-05Z：文件名里不能有冒号（Windows）
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

const README = (at) =>
  [
    "Kimi Work 法律行业发行版 · 打不开的本机数据（已移到一边，没有删除）",
    "",
    `移动时刻：${at}`,
    "原因：这台电脑上的数据库密钥无法解开（常见于重置 Windows 账户密码、重装系统后还原用户目录）。",
    "这里的案件数据仍是加密的，只有原来的密钥才能打开；应用已改为从备份恢复。",
    "",
    "是否保留、何时清理，由所内 IT 决定。请勿把本目录拷给他人。",
    "",
  ].join("\r\n");

function quarantineUnreadable({ dataDir, keyFile, now = Date.now() }) {
  const moved = [];
  const dir = path.join(dataDir, `${PREFIX}${stamp(now)}`);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(dir);
  } catch (e) {
    return { ok: false, code: e && e.code === "EEXIST" ? "exists" : "move_failed", moved };
  }
  const move = (from, name) => {
    fs.renameSync(from, path.join(dir, name));
    moved.push(name);
  };
  try {
    fs.writeFileSync(path.join(dir, "说明.txt"), README(new Date(now).toISOString()), { flag: "wx" });
    for (const f of RECORD_FILES) if (fs.existsSync(path.join(dataDir, f))) move(path.join(dataDir, f), f);
    for (const e of fs.readdirSync(dataDir, { withFileTypes: true })) {
      // 只移有账本的工作区（含待激活占位工作区）；以点开头的（本目录与以前移过的）不动
      if (!e.isDirectory() || !SLUG.test(e.name)) continue;
      if (!fs.existsSync(path.join(dataDir, e.name, "ledger.db"))) continue;
      move(path.join(dataDir, e.name), e.name);
    }
    if (fs.existsSync(keyFile)) move(keyFile, path.basename(keyFile));
    return { ok: true, dir, moved };
  } catch (e) {
    // 跨卷改名（userData 与数据根不在同一个盘）不退化为“复制再删除”：宁可停下交给 IT
    return { ok: false, code: e && e.code === "EXDEV" ? "cross_device" : "move_failed", moved };
  }
}

/** 以前移到一边的目录（新的在前；只报目录名，界面据此说“原来的数据在哪”）。 */
function listSetAside(dataDir) {
  try {
    return fs
      .readdirSync(dataDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(PREFIX))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

module.exports = { quarantineUnreadable, listSetAside, UNREADABLE_PREFIX: PREFIX };
