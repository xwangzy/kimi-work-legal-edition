/**
 * 自动更新（W7）：electron-updater 的 NSIS 更新器 + 本产品的核验（update-verify.cjs）。
 *
 * - 只在安装包形态、且 release.json 配置了 update_base / update_pins / update_keys 时启用；更新地址与发布者经 setFeedURL 与
 *   release.json（asar 内）设定，不取自 resources/app-update.yml——但 electron-updater 仍从该文件读缓存目录名（只影响缓存位置）；
 * - 更新器专用会话（electron-updater 分区，electron-updater 的 net 请求也走它）：只允许更新源主机的 https 地址，
 *   证书链须命中钉住集，命中后仍沿用 Chromium 的证书透明度结果（回调 -3，复核 B4-A06）；
 * - 下载前：先取按渠道命名的签名清单（kwl-update-<渠道>.json）核验签名、有效期、版本与文件名，不符不下载（复核 B4-A07）；
 * - 下载完成后：再按清单核对版本、文件名、大小与 sha512（不一致即删除下载）；缓存命中（重启后直接用已下载文件）同样重新核验（复核 B4-A04）；
 * - 安装前（退出时）：用内存里已核验的清单重算安装包大小与 sha512，不符即放弃安装——从下载到退出可能相隔数天（复核 B4-A04）；
 * - 后台静默下载，界面横幅提示“新版本已就绪，重启后生效”，由律师选择时机重启；退出时自动安装；不强制、不打断进行中的任务；
 * - 不接受降级（回滚以发布更高版本号的旧代码实现）；不做分阶段灰度：更新请求的 x-user-staging-id 固定为全零，
 *   不在本机生成持久更新编号（复核 B4-A16）。
 * 更新请求只含版本号与渠道（以及网络层必然可见的 IP 与 User-Agent），不含任何事项内容；写入“中软看得到什么”。
 */
const fs = require("node:fs");
const {
  verifyReleaseManifest,
  checkDownloaded,
  tlsPinMatch,
  manifestNameOf,
  classifyUpdateError,
  fallbackManifest,
  ManifestUnavailableError,
} = require("./update-verify.cjs");

const CHECK_DELAY_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const NIL_STAGING_ID = "00000000-0000-0000-0000-000000000000";

// 日志器由主进程传入（只记事件码，消息文字丢弃；复核 S5A-06）；缺省什么都不输出，不回落到 console
const SILENT = { warn: () => {}, error: () => {} };
function initUpdater({ app, session, release, onStatus, log = SILENT }) {
  if (!app.isPackaged || process.platform !== "win32") return { enabled: false, reason: "only_packaged_windows" };
  const cfg = release && release.update;
  if (!cfg) return { enabled: false, reason: "not_configured" };
  const { NsisUpdater } = require("electron-updater");
  const host = new URL(cfg.base).host;
  const manifestUrl = `${cfg.base}/${manifestNameOf(cfg.channel)}`;

  // 更新器专用会话：只许更新源主机、证书链须命中钉住集
  const ses = session.fromPartition("electron-updater", { cache: false });
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (d, cb) => {
    let ok = false;
    try {
      const u = new URL(d.url);
      ok = u.protocol === "https:" && u.host === host;
    } catch {
      ok = false;
    }
    cb(ok ? {} : { cancel: true });
  });
  ses.setCertificateVerifyProc((req, cb) => {
    if (req.verificationResult !== "net::OK") return cb(-2);
    const chain = [];
    for (let c = req.certificate; c; c = c.issuerCert) {
      chain.push(c.data);
      if (c.issuerCert === c || chain.length > 8) break;
    }
    // -3：沿用 Chromium 的校验结果（含证书透明度）；0 会把 CT 一并关掉
    cb(tlsPinMatch(chain, cfg.pins) ? -3 : -2);
  });
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));

  /** 取并核验签名清单；网络或 HTTP 失败抛 ManifestUnavailableError（界面只提示稍后重试），签名或内容不符抛普通错误。 */
  async function fetchManifest() {
    let res;
    try {
      res = await ses.fetch(manifestUrl, { cache: "no-store" });
    } catch (e) {
      throw new ManifestUnavailableError(`取不到发布签名清单（${e && e.message ? e.message : e}）`);
    }
    if (!res.ok) throw new ManifestUnavailableError(`取不到发布签名清单（HTTP ${res.status}）`);
    return verifyReleaseManifest(await res.text(), cfg.keys, { channel: cfg.channel });
  }

  /** latest.yml 里的安装包：文件名（与签名清单比对）；地址若是绝对地址必须同在更新源主机。 */
  function installerOf(info) {
    const f = (info && Array.isArray(info.files) && info.files[0]) || null;
    const raw = String((f && f.url) || (info && info.path) || "");
    const u = new URL(raw, `${cfg.base}/`);
    if (u.host !== host || u.protocol !== "https:") throw new Error("更新描述里的安装包地址不在更新源主机");
    return decodeURIComponent(u.pathname.split("/").pop() || "");
  }

  let pending = null; // { version, file }：update-available 时登记
  let verified = null; // { version, payload }：下载核验通过的清单（安装前复核用）
  let preVerified = null; // update-available 时已核验的清单：下载后再取清单遇网络失败时回用（仍须在有效期内、同一版本；复核 B4-R16）

  /** 取清单；网络失败时回用下载前已核验、仍在有效期内的同版本清单（不因一次网络抖动丢弃整包）。 */
  async function manifestForVersion(version) {
    try {
      return await fetchManifest();
    } catch (e) {
      const fb = fallbackManifest(e, preVerified, version);
      if (fb) return fb;
      throw e;
    }
  }

  const rejected = (reason) => Object.assign(new Error(reason), { code: "KWL_UPDATE_REJECTED" });

  class KwlUpdater extends NsisUpdater {
    // 覆盖签名核验：不依赖 app-update.yml 里的发布者（可被本机改写）；按发布签名清单核对下载的安装包
    async verifySignature(tempUpdateFile) {
      let payload;
      try {
        payload = await manifestForVersion(pending && pending.version);
      } catch (e) {
        if (e instanceof ManifestUnavailableError) throw e; // 普通错误：界面显示“稍后重试”，不报签名不符
        return e && e.message ? e.message : String(e);
      }
      const bad = checkDownloaded(payload, { expectedVersion: pending && pending.version, currentVersion: app.getVersion(), file: tempUpdateFile, expectedFile: pending && pending.file });
      if (bad) return bad;
      // 第二层：Windows 代码签名（Authenticode）发布者核对——发布者名称取自随 asar 的 release.json（正式证书到位后配置）
      if (cfg.publishers && cfg.publishers.length) {
        const { verifySignature } = require("electron-updater/out/windowsExecutableCodeSignatureVerifier");
        const r = await verifySignature(cfg.publishers, tempUpdateFile, updater.logger);
        if (r) return r;
      }
      verified = { version: payload.version, payload };
      return null;
    }

    // 安装前复核（复核 B4-A04）：按已核验清单重算安装包大小与 sha512；没有核验记录或不符即放弃安装并删除文件
    doInstall(options) {
      // 按机器安装（须管理员权限）时不自动安装（复核 B4-R16）：安装包在本人可写的目录里，复核与提权运行之间仍有窗口——交给所内 IT 部署
      if (options && options.isAdminRightsRequired) {
        onStatus({ state: "error", version: verified && verified.version, message: "这台电脑上的应用是为所有用户安装的，更新须由所内 IT 部署。" });
        return false;
      }
      const file = this.installerPath;
      const bad = !file || !verified ? "安装包没有经过本次运行的核验" : checkDownloaded(verified.payload, { expectedVersion: verified.version, currentVersion: app.getVersion(), file, expectedFile: verified.payload.file });
      if (bad) {
        log.error(`[update] 放弃安装：${bad}`);
        try {
          if (file) fs.unlinkSync(file);
        } catch {
          // 尽力删除
        }
        onStatus({ state: "rejected", version: verified && verified.version, message: classifyUpdateError(rejected(bad)).message });
        return false;
      }
      return super.doInstall(options);
    }
  }
  const updater = new KwlUpdater({ provider: "generic", url: cfg.base, channel: cfg.channel });
  // 不生成、不发送持久更新编号（electron-updater 缺省把 userData/.updaterId 里的随机编号放进 x-user-staging-id 请求头）
  updater.stagingUserIdPromise = { value: Promise.resolve(NIL_STAGING_ID) };
  updater.logger = { info: () => {}, warn: (m) => log.warn(`[update] ${m}`), error: (m) => log.error(`[update] ${m}`), debug: () => {} };
  updater.autoDownload = false; // 先核验签名清单再下载
  updater.autoInstallOnAppQuit = true;
  updater.allowDowngrade = false;
  updater.allowPrerelease = cfg.channel === "beta";
  updater.disableWebInstaller = true;
  updater.fullChangelog = false;

  const report = (e) => {
    log.error(`[update] ${e && e.message ? e.message : e}`);
    const c = classifyUpdateError(e);
    onStatus({ state: c.state, version: pending && pending.version, message: c.message });
  };

  updater.on("checking-for-update", () => onStatus({ state: "checking" }));
  updater.on("update-not-available", () => onStatus({ state: "idle" }));
  updater.on("update-available", (info) => {
    void (async () => {
      try {
        const file = installerOf(info);
        pending = { version: info.version, file };
        const p = await fetchManifest();
        if (p.version !== info.version || p.file !== file) throw rejected(`签名清单（${p.version} ${p.file}）与更新描述（${info.version} ${file}）不一致`);
        preVerified = p;
        onStatus({ state: "downloading", version: info.version, percent: 0 });
        await updater.downloadUpdate();
      } catch (e) {
        report(e && e.code ? e : Object.assign(e instanceof Error ? e : new Error(String(e)), { code: e instanceof ManifestUnavailableError ? e.code : "KWL_UPDATE_REJECTED" }));
      }
    })();
  });
  updater.on("download-progress", (p) => onStatus({ state: "downloading", version: pending && pending.version, percent: Math.round(p.percent) }));
  updater.on("update-downloaded", (info) => {
    if (verified && verified.version === info.version) return onStatus({ state: "ready", version: info.version });
    // 缓存命中（此前已下载、本次运行未经 verifySignature）：按签名清单重新核验缓存文件
    void (async () => {
      try {
        const p = await manifestForVersion(info.version);
        const bad = checkDownloaded(p, { expectedVersion: info.version, currentVersion: app.getVersion(), file: info.downloadedFile, expectedFile: pending && pending.file });
        if (bad) throw rejected(bad);
        verified = { version: p.version, payload: p };
        onStatus({ state: "ready", version: info.version });
      } catch (e) {
        if (!(e instanceof ManifestUnavailableError)) {
          try {
            fs.unlinkSync(info.downloadedFile);
          } catch {
            // 尽力删除
          }
        }
        report(e && e.code ? e : rejected(String(e && e.message ? e.message : e)));
      }
    })();
  });
  updater.on("error", report);

  const check = () => updater.checkForUpdates().catch(() => {});
  const t1 = setTimeout(check, CHECK_DELAY_MS);
  const t2 = setInterval(check, CHECK_EVERY_MS);
  return {
    enabled: true,
    check,
    install: () => updater.quitAndInstall(true, true),
    dispose: () => {
      clearTimeout(t1);
      clearInterval(t2);
    },
  };
}

module.exports = { initUpdater };
