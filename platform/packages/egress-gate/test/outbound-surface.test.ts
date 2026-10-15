/**
 * 出网面扫描（v9 第 04 篇 §5.1 第②级“CI 扫描出网面”、§11 P5“Agent 宿主与 kap-server 出网面扫描无直连路径”）：
 * 律师电脑上各进程的源码里，凡直接使用网络能力的位置（底层网络模块的静态与动态导入、undici、ws、全局 fetch、WebSocket）都必须在清单里并写明理由；
 * 能绕过静态扫描的写法（计算式 `import()`/`require()`、`createRequire`、方括号访问全局对象、`process.binding`）另有一份精确清单（阶段 4 审查 S4-10）。
 * 清单是精确集合：新增一处即失败，删掉一处也要同步清单。kap-server 制品的出网面另由 packages/kap-host/test/static-surface.test.ts 按输入文件扫描。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** 允许的网络代码位置 → 理由（相对 platform/）。 */
const ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  // 出站闸门：唯一出口
  "packages/egress-gate/src/fetcher.ts": "闸门本机抓取：解析域名并校验公网地址、连接钉住已校验地址（唯一出口）",
  "packages/egress-gate/src/server.ts": "闸门服务：监听本机套接字；转发到配置的网关/检索服务/自带密钥端点（唯一出口）",
  "packages/egress-gate/src/url-guard.ts": "只用 node:net 的 BlockList/isIP 做地址分类，不发起连接",
  "packages/egress-gate/src/tls-policy.ts": "闸门上游请求实现（审计 S5）：undici Agent 证书校验不放宽、握手时核对内置钉住集，只被闸门服务与控制面通道使用（唯一出口）",
  "packages/egress-gate/src/cp-relay.ts": "闸门控制面通道（阶段 6）：内核经 IPC 交来的控制面请求，只发往本机配置固定的控制面地址（路径与请求头白名单、不跟随跳转；唯一出口）",
  // 本机通道（套接字/命名管道）
  "packages/model-broker/src/providers/gate.ts": "undici 只连出站闸门的本机套接字（内核不直连上游）",
  "packages/kap-host/src/host-egress.ts": "宿主出口：undici 只连出站闸门与内核的本机套接字；其余主机名在本进程内失败",
  "packages/kap-host/src/main.ts": "安装上面的宿主出口为进程全局调度器",
  "packages/kernel/src/local-server.ts": "内核本机端点：只监听本机套接字/管道（与开发用回环端口），不发起外连",
  "packages/kernel/src/index.ts": "只有 node:http 的 Server 类型导入",
  "packages/exec-wasm/src/supervisor.ts": "W 自检：在 --permission 下做一次 DNS 查询，确认失败（证明无网），不发起连接",
  // 渲染进程（阶段 5 W1 纳入扫描）
  "apps/desktop/src/api.ts": "只在 web 开发形态连本机开发桥（127.0.0.1:7720，带令牌与源校验）；桌面客户端经主进程 IPC，生产 CSP connect-src 'none'，主进程网络层拦截一切非本机请求",
});

/** 能绕过静态扫描的写法 → 理由（精确清单）。 */
const COMPUTED_ALLOWED: Readonly<Record<string, string>> = Object.freeze({
  "packages/exec-wasm/src/jb-loader.ts": "按锁定摘要校验后装载 just-bash 模块（file: 与 data: URL）；运行在无网的 W 监督进程内",
});

/** 不在律师电脑 Agent 链路上的目录（如实列出，不计入本扫描）。 */
const OUT_OF_SCOPE: Readonly<Record<string, string>> = Object.freeze({
  "services/": "中软云端服务 v0（法律模型网关、检索服务、控制面与其订阅器）：部署在云端，本机测试以回环端口模拟",
  "packages/im-connectors/": "律所节点 IM 连接器（v5 原型，钉钉 Stream WebSocket）：运行在所内节点；v9 G2 改经中软 im-isv，不在律师电脑 Agent 链路",
  "apps/firm-node/": "所内节点（同上）",
  "apps/desktop/electron/": "Electron 主进程：除自动更新（updater.cjs，D-58，见下方专门用例）外不发起网络连接；对渲染会话做网络层拦截，见 desktop 安全检查用例",
});

const NET_MODULES = "(?:node:)?(?:net|tls|http|https|http2|dgram|dns|dns\\/promises)|undici|ws";
const NET = new RegExp(
  [
    `from\\s+["'](?:${NET_MODULES})["']`,
    `require\\(\\s*["'](?:${NET_MODULES})["']\\s*\\)`,
    `import\\s*\\(\\s*["'](?:${NET_MODULES})["']\\s*\\)`,
    `(?<![.\\w$])fetch\\s*\\(`,
    `new\\s+WebSocket\\s*\\(`,
    `XMLHttpRequest`,
    `globalThis\\.fetch`,
  ].join("|"),
);
const COMPUTED = new RegExp(
  [
    `import\\s*\\(\\s*(?!["'\\s])`,
    `require\\s*\\(\\s*(?!["'\\s])`,
    `createRequire`,
    `globalThis\\s*\\[`,
    `\\bglobal\\s*\\[`,
    `process\\s*\\.\\s*(?:binding|_linkedBinding)`,
    `Reflect\\s*\\.\\s*get\\s*\\(\\s*globalThis`,
  ].join("|"),
);

/** 去掉注释（尊重字符串与模板字面量，避免字符串里的 "/*" 吞掉代码；审查 S4-10）。 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") {
          out += src[i]! + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (q !== "`" && src[i] === "\n") break;
        out += src[i]!;
        i++;
      }
      if (i < src.length) out += src[i]!;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
}

function sources(): { rel: string; text: string }[] {
  const files: string[] = [];
  for (const top of ["packages", "apps"]) {
    for (const name of readdirSync(join(root, top))) {
      const src = join(root, top, name, "src");
      try {
        if (statSync(src).isDirectory()) walk(src, files);
      } catch {
        // 没有 src 目录
      }
    }
  }
  return files
    .map((f) => relative(root, f).replaceAll("\\", "/"))
    .filter((rel) => !Object.keys(OUT_OF_SCOPE).some((d) => rel.startsWith(d)))
    .map((rel) => ({ rel, text: stripComments(readFileSync(join(root, rel), "utf8")) }));
}

test("出网面：律师电脑各进程源码中的网络代码只在登记的位置（闸门是唯一出口；其余只连本机通道或只监听本机）", () => {
  const hits = sources()
    .filter((f) => NET.test(f.text))
    .map((f) => f.rel)
    .sort();
  const unexpected = hits.filter((h) => !(h in ALLOWED));
  assert.deepEqual(unexpected, [], `未登记的网络代码：${unexpected.join("、")}`);
  const stale = Object.keys(ALLOWED).filter((k) => !hits.includes(k));
  assert.deepEqual(stale, [], `清单里的位置已没有网络代码（请同步清单）：${stale.join("、")}`);
});

test("出网面（审查 S4-10）：计算式 import()/require()、createRequire、方括号访问全局对象、process.binding 只在登记的位置", () => {
  const hits = sources()
    .filter((f) => COMPUTED.test(f.text))
    .map((f) => f.rel)
    .sort();
  const unexpected = hits.filter((h) => !(h in COMPUTED_ALLOWED));
  assert.deepEqual(unexpected, [], `未登记的可绕过静态扫描的写法：${unexpected.join("、")}`);
  const stale = Object.keys(COMPUTED_ALLOWED).filter((k) => !hits.includes(k));
  assert.deepEqual(stale, [], `清单里的位置已没有这类写法（请同步清单）：${stale.join("、")}`);
});

test("出网面扫描自身（审查 S4-10）：六种常见绕过写法都能识别；字符串里的注释符不会吞掉代码", () => {
  const cases = [
    `const m = await import("node:https");`,
    `const r = createRequire(import.meta.url); r("node:http");`,
    `const name = "node:" + "http"; require(name);`,
    `globalThis["fe" + "tch"]("https://x");`,
    `globalThis["fetch"]("https://x");`,
    `process.binding("tcp_wrap");`,
  ];
  for (const c of cases) assert.ok(NET.test(stripComments(c)) || COMPUTED.test(stripComments(c)), c);
  const tricky = `const s = "/*"; fetch("https://x"); const t = "*/";`;
  assert.ok(NET.test(stripComments(tricky)), "字符串里的 /* 不吞代码");
  assert.ok(!NET.test(stripComments("// fetch(x) 只是注释")), "注释里的 fetch 不计");
});

test("出网面：内核、模型代理与 Agent 宿主的源码不出现任何上游地址（凭据与地址只经 IPC 到闸门）", () => {
  const offenders: string[] = [];
  for (const f of sources()) {
    if (!/^(packages\/kernel|packages\/model-broker|packages\/kap-host)\/src\//.test(f.rel)) continue;
    if (/https?:\/\/api\.moonshot\.cn/.test(f.text) && f.rel !== "packages/kernel/src/egress/kernel-gate.ts") offenders.push(`${f.rel}：月之暗面地址`);
  }
  assert.deepEqual(offenders, [], offenders.join("；"));
});

test("出网面（D-58）：Electron 主进程只有自动更新（updater.cjs）一处出网——固定更新主机、SPKI 钉住、Ed25519 发布清单；其余主进程文件不发起连接", () => {
  const dir = join(root, "apps/desktop/electron");
  const NET_MAIN = /electron-updater|\.fetch\s*\(|net\.request\s*\(|require\(\s*["'](?:node:)?(?:https?|http2|net|tls|dgram)["']\s*\)/;
  const hits = readdirSync(dir)
    .filter((n) => n.endsWith(".cjs") && !n.includes(".bundle."))
    .filter((n) => NET_MAIN.test(stripComments(readFileSync(join(dir, n), "utf8"))))
    .sort();
  assert.deepEqual(hits, ["updater.cjs"], `主进程出网位置：${hits.join("、")}`);
  const up = readFileSync(join(dir, "updater.cjs"), "utf8");
  for (const must of ["setCertificateVerifyProc", "tlsPinMatch", "verifyReleaseManifest", "checkDownloaded", "allowDowngrade = false", "u.host === host"]) assert.ok(up.includes(must), `updater.cjs 缺少 ${must}`);
});
