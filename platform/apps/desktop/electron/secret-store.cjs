/**
 * 数据库主密钥的封装与解封（隐私安全审查 P0-2）。无 Electron 依赖，safeStorage 以参数注入，可单测。
 *
 * 规则：
 * - 主密钥：随机 32 字节 base64，经 safeStorage（Windows DPAPI / macOS 钥匙串）包裹落盘于 userData/ledger-key；
 * - 只在文件**不存在**时生成新密钥；文件存在但解封失败（Windows 用户配置迁移、重置密码导致 DPAPI 主密钥变化、文件损坏）
 *   一律**不覆盖**——返回 unseal_failed，由主进程给出恢复指引（覆盖会让旧账本永久打不开）；
 * - 安装包形态 safeStorage 不可用 → unavailable（拒绝以明文库启动）；开发形态允许明文开发库并告警；
 * - shouldReEncrypt → 用新口径重新包裹，先写临时文件再原子改名。
 *
 * 返回 { ok: true, key: string | null, created: boolean } 或 { ok: false, code: "unavailable" | "unseal_failed" | "write_failed", message }。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function loadOrCreateDbKey({ safeStorage, file, packaged }) {
  let available = false;
  try {
    available =
      typeof safeStorage.isAsyncEncryptionAvailable === "function" ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
  } catch {
    available = false;
  }
  if (!available) {
    if (packaged) return { ok: false, code: "unavailable", message: "系统数据保护（Windows DPAPI）不可用，无法加密保存本机数据库" };
    return { ok: true, key: null, created: false, warning: "safeStorage 不可用：开发形态以明文开发库启动" };
  }
  let wrapped = null;
  try {
    wrapped = fs.readFileSync(file);
  } catch (e) {
    if (!e || e.code !== "ENOENT") return { ok: false, code: "unseal_failed", message: `无法读取数据库密钥文件（${e && e.code ? e.code : "未知错误"}）` };
  }
  if (wrapped) {
    let dec;
    try {
      dec = await safeStorage.decryptStringAsync(wrapped);
    } catch (e) {
      return { ok: false, code: "unseal_failed", message: "数据库密钥无法解封（Windows 账户的数据保护密钥可能已变化）" };
    }
    if (!dec || typeof dec.result !== "string" || dec.result.length < 32) return { ok: false, code: "unseal_failed", message: "数据库密钥内容无效" };
    if (dec.shouldReEncrypt) {
      try {
        atomicWrite(file, await safeStorage.encryptStringAsync(dec.result));
      } catch {
        // 再包裹失败不影响本次使用：旧密文仍然有效
      }
    }
    return { ok: true, key: dec.result, created: false };
  }
  try {
    const key = crypto.randomBytes(32).toString("base64");
    const sealed = await safeStorage.encryptStringAsync(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 独占创建：并发的第二个实例不会覆盖第一个刚写下的密钥
    fs.writeFileSync(file, sealed, { mode: 0o600, flag: "wx" });
    return { ok: true, key, created: true };
  } catch (e) {
    return { ok: false, code: "write_failed", message: `无法保存数据库密钥（${e && e.code ? e.code : "未知错误"}）` };
  }
}

/** 崩溃转储只留本机、不上传，超过 maxAgeDays 的删除（隐私安全审查 P0-4：转储可能含内存中的案卷片段）。 */
function purgeOldDumps(dir, maxAgeDays = 3, now = Date.now()) {
  let removed = 0;
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          if (now - fs.statSync(p).mtimeMs > maxAgeDays * 86_400_000) {
            fs.rmSync(p, { force: true });
            removed += 1;
          }
        } catch {
          // 忽略
        }
      }
    }
  };
  walk(dir);
  return removed;
}

/**
 * 采用从恢复包取回的数据库主密钥（第 14 批“从备份恢复”）：用本机 safeStorage 重新包裹后替换 ledger-key；
 * 原包裹文件复制留档（ledger-key.prev-<时刻>，绝不删除；本机若有以前留下的数据，用它才能打开——驻留面第 20 类登记）。
 * 调用方只在内核处于待激活模式时调用。复核 R2A-06：先把新包裹写成独立文件、再复制留档、最后原子替换——任何一步中断，
 * ledger-key 都还在（要么是旧的，要么是新的），不会出现“文件不在、下次启动静默生成新主密钥”。所有异常都转成 {ok:false}。
 */
async function adoptDbKey({ safeStorage, file, key, now = Date.now() }) {
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32) return { ok: false, code: "key_invalid" };
  let available = false;
  try {
    available = typeof safeStorage.isAsyncEncryptionAvailable === "function" ? await safeStorage.isAsyncEncryptionAvailable() : safeStorage.isEncryptionAvailable();
  } catch {
    available = false;
  }
  if (!available) return { ok: false, code: "unavailable" };
  const next = `${file}.next`;
  try {
    const sealed = await safeStorage.encryptStringAsync(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(next, { force: true });
    fs.writeFileSync(next, sealed, { mode: 0o600, flag: "wx", flush: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.prev-${now}`, fs.constants.COPYFILE_EXCL);
    fs.renameSync(next, file);
    return { ok: true };
  } catch {
    try {
      fs.rmSync(next, { force: true });
    } catch {
      // 留着也无害：下次采用前会先删
    }
    return { ok: false, code: "write_failed" };
  }
}

module.exports = {
  adoptDbKey, loadOrCreateDbKey, purgeOldDumps };
