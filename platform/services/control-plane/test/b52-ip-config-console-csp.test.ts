/**
 * 第 52 批：换公网 IP（部署手册 4.7）后控制台登录不了——控制台打包时把控制面来源写进 index.html 页内 CSP 的 connect-src，
 * ip-config.mjs 原先只改 config.json，浏览器按旧 CSP 拦下全部接口请求（11-21 虚机浏览器实测：connect-src 仍是 https://192.168.64.2:8443）。
 * 现在 ip-config 用打包脚本同一个函数改写 connect-src。本用例在临时目录里按真实脚本走一遍：打包（旧 IP）→ ip-config（新 IP）→ 核对。
 * monorepo（cloud-repo/template/deploy）与独立云端仓库（deploy/）两种目录布局都能跑。
 * 第 53 批（D-218）：不再要 --ops-cidr（给了只提示已忽略）；改写 control-plane.json 时删掉遗留的 ops.allow_cidrs 与 console.staff_mfa。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const deploy = existsSync(join(root, "deploy/scripts/ip-config.mjs")) ? join(root, "deploy") : join(root, "cloud-repo/template/deploy");
const OLD_IP = "198.51.100.2";
const NEW_IP = "203.0.113.20";

test("换 IP：ip-config 同步改写控制台页内 CSP 的 connect-src（与重新打包一致），config.json 一并改", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kwl-ipcfg-csp-"));
  // 假的 /opt/kwl/app：只放 ip-config 用到的样例配置与打包脚本（打包脚本按自身位置找 apps/console，所以整份 apps/console 也带上）
  const app = join(dir, "app");
  mkdirSync(join(app, "deploy/config"), { recursive: true });
  mkdirSync(join(app, "scripts"), { recursive: true });
  cpSync(join(deploy, "config"), join(app, "deploy/config"), { recursive: true });
  copyFileSync(join(root, "scripts/build-console.mjs"), join(app, "scripts/build-console.mjs"));
  const { buildConsole, cspOf } = await import(pathToFileURL(join(root, "scripts/build-console.mjs")).href);
  const web = join(dir, "kwl-console");
  buildConsole(web, { controlPlane: `https://${OLD_IP}:8443` });
  writeFileSync(join(web, "config.json"), JSON.stringify({ control_plane_base: `https://${OLD_IP}:8443`, deployment: "stg", label: "演练" }));
  const etc = join(dir, "etc");
  mkdirSync(etc);
  const before = readFileSync(join(web, "index.html"), "utf8");
  assert.match(cspOf(before), new RegExp(`connect-src 'self' https://${OLD_IP.replaceAll(".", "\\.")}:8443;`));

  const r = spawnSync(process.execPath, [join(deploy, "scripts/ip-config.mjs"), "--app", app, "--etc", etc, "--public-ip", NEW_IP, "--console-dir", web], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  // 从样例新建的 control-plane.json：没有运维网段、没有两步验证策略
  const cpJson = () => JSON.parse(readFileSync(join(etc, "control-plane.json"), "utf8"));
  assert.equal(cpJson().ops?.allow_cidrs, undefined, "control-plane.json 里不应有 ops.allow_cidrs");
  assert.equal(cpJson().console?.staff_mfa, undefined, "control-plane.json 里不应有 console.staff_mfa");
  assert.deepEqual(cpJson().console.origins, [`https://${NEW_IP}`]);
  const after = readFileSync(join(web, "index.html"), "utf8");
  const csp = cspOf(after);
  assert.match(csp, new RegExp(`connect-src 'self' https://${NEW_IP.replaceAll(".", "\\.")}:8443;`));
  assert.ok(!after.includes(OLD_IP), "旧 IP 不应再出现在页面里");
  // 与按新地址重新打包的结果逐字节一致（只改 connect-src，别的 CSP 指令与页面不动）
  const fresh = join(dir, "fresh");
  buildConsole(fresh, { controlPlane: `https://${NEW_IP}:8443` });
  assert.equal(after, readFileSync(join(fresh, "index.html"), "utf8"));
  assert.equal(JSON.parse(readFileSync(join(web, "config.json"), "utf8")).control_plane_base, `https://${NEW_IP}:8443`);
  assert.match(r.stdout, /页内 CSP connect-src 'self' https:\/\/203\.0\.113\.20:8443/);

  // 再跑一次：幂等，报“未变”
  const again = spawnSync(process.execPath, [join(deploy, "scripts/ip-config.mjs"), "--app", app, "--etc", etc, "--public-ip", NEW_IP, "--console-dir", web], { encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /（未变）/);
  assert.equal(readFileSync(join(web, "index.html"), "utf8"), after);

  // 老部署（D-218 之前）：配置里还有运维网段与两步验证策略，命令里还带 --ops-cidr——照常成功、提示已忽略、两项从配置里删掉，别的项不动
  const legacy = cpJson();
  legacy.ops = { ...legacy.ops, allow_cidrs: ["192.0.2.5/32"] };
  legacy.console = { ...legacy.console, staff_mfa: "required" };
  writeFileSync(join(etc, "control-plane.json"), JSON.stringify(legacy));
  const old = spawnSync(process.execPath, [join(deploy, "scripts/ip-config.mjs"), "--app", app, "--etc", etc, "--public-ip", NEW_IP, "--ops-cidr", "192.0.2.5/32", "--console-dir", web], { encoding: "utf8" });
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /--ops-cidr 已废弃、已忽略/);
  assert.match(old.stdout, /删掉已废弃的 ops\.allow_cidrs、console\.staff_mfa/);
  const cleaned = cpJson();
  assert.equal(cleaned.ops?.allow_cidrs, undefined, "升级 / 换 IP 后 control-plane.json 里没有 allow_cidrs");
  assert.equal(cleaned.console?.staff_mfa, undefined, "升级 / 换 IP 后 control-plane.json 里没有 staff_mfa");
  assert.equal(cleaned.ops?.deployment, "prod", "ops 段的其他项保留");
  assert.deepEqual(cleaned.console.bootstrap_admin, legacy.console.bootstrap_admin);
  assert.ok(!readFileSync(join(etc, "control-plane.json"), "utf8").includes("allow_cidrs"));
});
