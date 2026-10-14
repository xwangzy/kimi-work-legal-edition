/**
 * 桌面客户端的出网面（v9 第 04 篇 §1.2 约束 3、§5.1 ③；第 06 篇 T07“渲染……打开 Agent 产物零外部请求”）——静态核验：
 * - 主进程：渲染会话网络层拦截一切非本机请求；拒绝全部权限请求；不打开外部浏览器；窗口与隔离框架都不能导航到应用之外；webview 不可挂载；
 *   窗口 sandbox、contextIsolation、关闭 Node；
 * - 渲染进程 CSP：生产 default-src 'none' 起步、connect-src 'none'；
 * - 产物预览：sandbox="" 隔离框架 + 注入更严的 CSP（只允许内联样式与 data: 资源）；
 * - 预加载脚本只暴露 invoke / onEvent / 文件路径 / 拦截计数。
 * 运行时证据另见进度文档（浏览器内恶意产物预览的网络请求记录）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../apps/desktop/", import.meta.url));
const read = (rel: string) => readFileSync(`${root}${rel}`, "utf8");

test("主进程：渲染会话网络层拦截非本机请求、拒绝权限、不打开外部浏览器、窗口与框架不导航到应用之外", () => {
  const main = read("electron/main.cjs");
  // 安装包形态必须接入控制面（复核 S6-A17）：缺控制面配置即退出模式，不能以本机配置项的开发形态运行。
  // 环境拼装在 release-config.cjs 的 kernelChildEnv（行为见 apps/desktop/test/release-config.test.ts；复核 C-A15）
  assert.match(main, /kernelChildEnv\(\{\s*packaged: app\.isPackaged,/);
  assert.match(read("electron/release-config.cjs"), /o\.packaged \? \{ ZR_REQUIRE_CONTROL_PLANE: "1", ZR_AT_REST: "required" \}/);
  assert.match(main, /webRequest\.onBeforeRequest\(\{ urls: \["<all_urls>"\] \}/);
  assert.match(main, /callback\(\{ cancel: true \}\)/);
  assert.match(main, /setPermissionRequestHandler\(\(_wc, _permission, callback\) => callback\(false\)\)/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.doesNotMatch(main, /openExternal/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /will-frame-navigate/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  // 地址策略共用 url-policy.cjs（下一条用例按行为核验）；IPC 只认应用主框架（复核 S5-B14）
  assert.match(main, /require\("\.\/url-policy\.cjs"\)/);
  assert.match(main, /if \(allowedRendererUrl\(details\.url\)\) return callback\(\{\}\)/);
  assert.match(main, /if \(!allowedMainNavigation\(url\)\) event\.preventDefault\(\)/);
  assert.match(main, /if \(!fromAppMainFrame\(e\)\) return Promise\.resolve\(\{ ok: false/);
  assert.match(main, /frame !== e\.sender\.mainFrame/);
  assert.doesNotMatch(main, /url\.startsWith\("file:\/\/"\)/, "不得再按 file:// 前缀放行（UNC 主机即外连）");
  assert.match(main, /const DEV_ORIGINS = \["http:\/\/127\.0\.0\.1:5173", "ws:\/\/127\.0\.0\.1:5173"\]/);
});

test("地址策略（行为）：生产只放行本包 dist 内、主机为空的 file:// 地址；UNC 主机、包外文件、任意网址一律拦截；开发只多认 vite", () => {
  const { createUrlPolicy } = createRequire(import.meta.url)(`${root}electron/url-policy.cjs`) as {
    createUrlPolicy(o: { appDist: string; isDev: boolean; devServer: string; devOrigins: string[] }): {
      allowedRendererUrl(u: string): boolean;
      allowedMainNavigation(u: string): boolean;
    };
  };
  const dist = join(tmpdir(), "kwl-dist-probe", "dist");
  const prod = createUrlPolicy({ appDist: dist, isDev: false, devServer: "http://127.0.0.1:5173", devOrigins: ["http://127.0.0.1:5173", "ws://127.0.0.1:5173"] });
  const inside = pathToFileURL(join(dist, "assets", "index.js")).href;
  assert.equal(prod.allowedRendererUrl(inside), true);
  assert.equal(prod.allowedMainNavigation(pathToFileURL(join(dist, "index.html")).href), true);
  for (const u of [
    "file://fileserver/share/x.png", // UNC 主机
    pathToFileURL(join(tmpdir(), "outside.png")).href, // 包外文件
    pathToFileURL(join(dist, "..", "secret.txt")).href, // 目录穿越到包外
    "http://127.0.0.1:5173/", // 生产不认开发服务
    "https://example.invalid/x",
    "ws://127.0.0.1:9/",
  ]) {
    assert.equal(prod.allowedRendererUrl(u), false, u);
    assert.equal(prod.allowedMainNavigation(u), false, u);
  }
  for (const u of ["data:image/png;base64,AA==", "blob:abc", "about:srcdoc", "about:blank", "devtools://devtools/x"]) assert.equal(prod.allowedRendererUrl(u), true, u);
  const dev = createUrlPolicy({ appDist: dist, isDev: true, devServer: "http://127.0.0.1:5173", devOrigins: ["http://127.0.0.1:5173", "ws://127.0.0.1:5173"] });
  assert.equal(dev.allowedRendererUrl("http://127.0.0.1:5173/src/main.tsx"), true);
  assert.equal(dev.allowedRendererUrl("ws://127.0.0.1:5173/"), true);
  assert.equal(dev.allowedRendererUrl("http://127.0.0.1:7720/invoke"), false, "开发桥只能经 vite 页面以 connect-src 访问（CSP），网络层不额外放行");
  assert.equal(dev.allowedMainNavigation("http://127.0.0.1:5173.evil.invalid/"), false);
});

test("渲染进程 CSP：生产 default-src 'none' 起步、connect-src 'none'、不允许内联脚本；index.html 由构建注入", () => {
  const vite = read("vite.config.ts");
  assert.match(vite, /"default-src 'none'"/);
  assert.match(vite, /dev \? "connect-src 'self' http:\/\/127\.0\.0\.1:7720 ws:\/\/127\.0\.0\.1:5173" : "connect-src 'none'"/);
  assert.match(vite, /dev \? "script-src 'self' 'unsafe-inline'" : "script-src 'self'"/);
  assert.match(vite, /"object-src 'none'"/);
  assert.match(vite, /"base-uri 'none'"/);
  assert.match(read("index.html"), /content="%KWL_CSP%"/);
});

test("Agent 产物预览：sandbox=\"\" 隔离框架 + 注入只允许内联样式与 data: 资源的 CSP；清洗去掉脚本、框架、表单、meta 跳转与外部引用", () => {
  const sp = read("src/lib/safe-preview.ts");
  assert.match(sp, /export const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'"/);
  for (const tag of ["script", "iframe", "object", "embed", "base", "link", "meta", "form"]) assert.match(sp, new RegExp(`"${tag}"`), tag);
  const comp = read("src/components/SafePreview.tsx");
  assert.match(comp, /<iframe title=\{filename\} sandbox="" srcDoc=\{srcDoc\} referrerPolicy="no-referrer"/);
});

test("预加载脚本只暴露最小接口；渲染进程源码里只有 api.ts 接触内核通道与开发桥", () => {
  const pre = read("electron/preload.cjs");
  const exposed = [...pre.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(exposed.sort(), ["getPathForFile", "invoke", "onEvent", "platform", "rendererNet"].sort());
});

test("对外口径（第 02 篇 §12 禁用词；复核 S5-A03）：界面、确认卡、告知函与估价文字不出现绝对化承诺", () => {
  const BANNED = ["永远", "绝对", "从不", "技术上不可能", "从来没有", "零风险", "数据不出所", "数据不出律所", "可安全运行代码", "不可能泄露", "零外传"];
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(repo, "apps/desktop/src"));
  walk(join(repo, "packages/kernel/src/services"));
  walk(join(repo, "packages/kernel/src/api"));
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // 只看用户可见的文字：字符串字面量、模板字符串与 JSX 文本（注释不算）
    const texts = [
      ...src.matchAll(/"(?:[^"\\\n]|\\.)*"/g),
      ...src.matchAll(/'(?:[^'\\\n]|\\.)*'/g),
      ...src.matchAll(/`(?:[^`\\]|\\.)*`/g),
      ...src.matchAll(/>([^<>{}]*[\u4e00-\u9fff][^<>{}]*)</g),
    ].map((m) => m[0]);
    for (const t of texts) for (const w of BANNED) if (t.includes(w)) hits.push(`${f.slice(repo.length)}：${w}：${t.slice(0, 60)}`);
  }
  assert.deepEqual(hits, []);
});
