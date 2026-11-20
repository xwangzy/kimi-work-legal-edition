#!/usr/bin/env node
/**
 * 纯公网 IP 部署：把与地址有关的配置项填进 /etc/kwl/*.json 与控制台 config.json（install.sh --public-ip 调用；可重复执行）。
 *
 *   node deploy/scripts/ip-config.mjs --app /opt/kwl/app --etc /etc/kwl --public-ip <IPv4> [--ops-cidr <网段>]... \
 *        [--admin-email <邮箱> --admin-name <姓名>] [--no-connect-address] [--console-dir /var/www/kwl-console]
 *
 * 改的只有这些（其余项保留现值；文件不在时从 deploy/config/*.example.json 起）：
 * - control-plane.json：console.origins 换成 https://<IP>（去掉样例域名，保留别的来源）；ops.allow_cidrs（给了 --ops-cidr 才改）；
 *   console.bootstrap_admin（给了才改）
 * - gateway.json、search.json：control_plane.url = https://<IP>:<控制面端口>；control_plane.connect_address = "127.0.0.1"
 *   （单机时连回环、证书仍按公网 IP 核对，避开云主机连不回自己公网 IP 的问题；多机部署加 --no-connect-address）
 * - 控制台 config.json：control_plane_base（文件不在时按样例新建）；已打包的 index.html 页内 CSP 的 connect-src 同步换成新控制面来源
 * 以后换成域名：把这几项改成域名地址、换证书即可，不用改代码（部署手册 4.6）。
 * 签名服务配置不涉及地址，按部署手册第 6 节另做。
 */
import { chownSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const one = (n) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? null : (args[i + 1] ?? "");
};
const many = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1] ?? ""] : []));
const die = (m) => {
  console.error(`[ip-config] ${m}`);
  process.exit(2);
};
const app = one("app") ?? "/opt/kwl/app";
const etc = one("etc") ?? "/etc/kwl";
const ip = one("public-ip");
const consoleDir = one("console-dir");
if (!ip || !isIPv4(ip)) die("--public-ip 须为 IPv4 地址（如 203.0.113.10）");
const EXAMPLE_CIDR = "10.20.0.0/24";

/** 运维出口网段：a.b.c.d/n，不许回环、不许 0.0.0.0/0 */
function checkCidr(c) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(c);
  if (!m || !isIPv4(m[1]) || Number(m[2]) > 32) die(`--ops-cidr ${c} 不是 IPv4 网段（单个地址写 /32，如 203.0.113.5/32）`);
  if (m[1].startsWith("127.")) die("--ops-cidr 不能是回环地址：控制面按来源地址放行平台运营，回环一律拒绝");
  if (Number(m[2]) === 0) die("--ops-cidr 不能是 0.0.0.0/0：平台运营入口只对运维出口开放");
  return c;
}
const opsCidrs = many("ops-cidr").map(checkCidr);

const load = (role) => {
  const f = join(etc, `${role}.json`);
  const src = existsSync(f) ? f : join(app, "deploy/config", `${role}.example.json`);
  try {
    return { file: f, cfg: JSON.parse(readFileSync(src, "utf8")), fresh: src !== f };
  } catch {
    die(`${src} 读不出或不是 JSON`);
  }
};
const save = (file, cfg, mode = 0o640) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode });
  // 沿用原文件的属主与属组（root:kwl）：写临时文件再改名会变成 root:root，服务用户 kwl 读不到配置、服务起不来——
  // 首次安装时 install.sh 之后统一改属组所以没暴露，单独重跑本脚本换 IP 时会把服务弄停（第 50 批虚机换 IP 演练发现）
  if (existsSync(file)) {
    const st = statSync(file);
    chownSync(tmp, st.uid, st.gid);
  }
  renameSync(tmp, file);
};

// 控制面
const cp = load("control-plane");
const cpPort = Number(cp.cfg.listen?.port ?? 8443);
const cpUrl = `https://${ip}${cpPort === 443 ? "" : `:${cpPort}`}`;
const consoleOrigin = `https://${ip}`; // 浏览器来源不带 :443
cp.cfg.console ??= {};
const keep = (cp.cfg.console.origins ?? []).filter((o) => typeof o === "string" && !o.includes("kwl.example.com") && !/^https:\/\/\d{1,3}(\.\d{1,3}){3}$/.test(o));
cp.cfg.console.origins = [consoleOrigin, ...keep];
cp.cfg.ops ??= {};
if (opsCidrs.length) cp.cfg.ops.allow_cidrs = opsCidrs;
const cidrs = cp.cfg.ops.allow_cidrs ?? [];
if (!cidrs.length || (cidrs.length === 1 && cidrs[0] === EXAMPLE_CIDR))
  die("缺 --ops-cidr：平台运营（登录控制台的平台人员、/v1/ops/*）只对这个网段开放。纯公网 IP 部署时填你自己电脑上网的公网出口地址，如 203.0.113.5/32（可在电脑上打开 https://ifconfig.me 查看）");
const adminEmail = one("admin-email");
if (adminEmail) cp.cfg.console.bootstrap_admin = { email: adminEmail, name: one("admin-name") ?? cp.cfg.console.bootstrap_admin?.name ?? "系统管理员" };
save(cp.file, cp.cfg);
console.log(`[ip-config] ${cp.file}：console.origins=${JSON.stringify(cp.cfg.console.origins)}，ops.allow_cidrs=${JSON.stringify(cp.cfg.ops.allow_cidrs)}${cp.fresh ? "（从样例新建：其余必改项见部署手册第 6 节）" : ""}`);

// 网关、检索
for (const role of ["gateway", "search"]) {
  const r = load(role);
  r.cfg.control_plane ??= { keys_file: "/etc/kwl/public/cp-public-keys.json" };
  r.cfg.control_plane.url = cpUrl;
  if (args.includes("--no-connect-address")) delete r.cfg.control_plane.connect_address;
  else r.cfg.control_plane.connect_address = "127.0.0.1";
  save(r.file, r.cfg);
  console.log(`[ip-config] ${r.file}：control_plane.url=${cpUrl}${r.cfg.control_plane.connect_address ? `，connect_address=${r.cfg.control_plane.connect_address}` : ""}${r.fresh ? "（从样例新建）" : ""}`);
}

// 控制台运行配置
if (consoleDir) {
  const f = join(consoleDir, "config.json");
  let c;
  try {
    c = JSON.parse(readFileSync(existsSync(f) ? f : join(app, "deploy/console/config.example.json"), "utf8"));
  } catch {
    die(`${f} 读不出或不是 JSON`);
  }
  c.control_plane_base = cpUrl;
  save(f, c, 0o644);
  console.log(`[ip-config] ${f}：control_plane_base=${cpUrl}`);
  // 页内 CSP（第 52 批）：控制台打包时把控制面来源写进 index.html 的 connect-src；只改 config.json 不改它，换 IP 后浏览器拦下全部接口请求、
  // 控制台登录不了（11-20 换 IP 演练漏掉，11-21 浏览器实测发现）。用打包脚本同一个函数改写，与重新打包结果一致
  const html = join(consoleDir, "index.html");
  if (existsSync(html)) {
    const { connectSrcFor, withConnectSrc, cspOf } = await import(pathToFileURL(join(app, "scripts/build-console.mjs")).href);
    const before = readFileSync(html, "utf8");
    const after = withConnectSrc(before, connectSrcFor(new URL(cpUrl).origin));
    if (after !== before) {
      const st = statSync(html);
      const tmp = `${html}.tmp-${process.pid}`;
      writeFileSync(tmp, after, { mode: 0o644 });
      try {
        chownSync(tmp, st.uid, st.gid);
      } catch {}
      renameSync(tmp, html);
    }
    console.log(`[ip-config] ${html}：页内 CSP ${/connect-src ([^;]*)/.exec(cspOf(after) ?? "")?.[0] ?? "?"}${after === before ? "（未变）" : ""}`);
  }
}
