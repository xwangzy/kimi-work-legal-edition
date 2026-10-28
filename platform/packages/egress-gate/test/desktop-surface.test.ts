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
import { join, sep } from "node:path";
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

test("地址策略（行为）：生产只放行应用协议 kwl://app/；任何 file:// 地址（含本包 dist、UNC 主机）、任意网址一律拦截；开发只多认 vite（复核 B4-A03）", () => {
  const req = createRequire(import.meta.url);
  const { createUrlPolicy } = req(`${root}electron/url-policy.cjs`) as {
    createUrlPolicy(o: { isDev: boolean; devServer: string; devOrigins: string[] }): {
      allowedRendererUrl(u: string): boolean;
      allowedMainNavigation(u: string): boolean;
    };
  };
  const dist = join(tmpdir(), "kwl-dist-probe", "dist");
  const prod = createUrlPolicy({ isDev: false, devServer: "http://127.0.0.1:5173", devOrigins: ["http://127.0.0.1:5173", "ws://127.0.0.1:5173"] });
  assert.equal(prod.allowedRendererUrl("kwl://app/assets/index.js"), true);
  assert.equal(prod.allowedMainNavigation("kwl://app/index.html"), true);
  for (const u of [
    pathToFileURL(join(dist, "index.html")).href, // 不再从 file:// 加载界面
    "file://fileserver/share/x.png", // UNC 主机
    pathToFileURL(join(tmpdir(), "outside.png")).href,
    "kwl://other/index.html", // 别的主机
    "kwl://user:pw@app/index.html",
    "kwl://app:8080/index.html",
    "http://127.0.0.1:5173/", // 生产不认开发服务
    "https://example.invalid/x",
    "ws://127.0.0.1:9/",
  ]) {
    assert.equal(prod.allowedRendererUrl(u), false, u);
    assert.equal(prod.allowedMainNavigation(u), false, u);
  }
  for (const u of ["data:image/png;base64,AA==", "blob:abc", "about:srcdoc", "about:blank", "devtools://devtools/x"]) assert.equal(prod.allowedRendererUrl(u), true, u);
  const dev = createUrlPolicy({ isDev: true, devServer: "http://127.0.0.1:5173", devOrigins: ["http://127.0.0.1:5173", "ws://127.0.0.1:5173"] });
  assert.equal(dev.allowedRendererUrl("http://127.0.0.1:5173/src/main.tsx"), true);
  assert.equal(dev.allowedRendererUrl("ws://127.0.0.1:5173/"), true);
  assert.equal(dev.allowedRendererUrl("http://127.0.0.1:7720/invoke"), false, "开发桥只能经 vite 页面以 connect-src 访问（CSP），网络层不额外放行");
  assert.equal(dev.allowedMainNavigation("http://127.0.0.1:5173.evil.invalid/"), false);

  // 应用协议只读 dist 内已知类型文件：穿越（含编码与反斜杠）、空字节、未知类型、别的主机一律不解析
  const { resolveAppFile, contentTypeOf } = req(`${root}electron/app-protocol.cjs`) as {
    resolveAppFile(d: string, u: string): string | null;
    contentTypeOf(f: string): string;
  };
  assert.equal(resolveAppFile(dist, "kwl://app/"), join(dist, "index.html"));
  assert.equal(resolveAppFile(dist, "kwl://app/assets/index-AB12.js"), join(dist, "assets", "index-AB12.js"));
  assert.equal(contentTypeOf(join(dist, "assets", "x.js")), "text/javascript; charset=utf-8");
  assert.equal(contentTypeOf(join(dist, "assets", "x.css")), "text/css; charset=utf-8");
  for (const u of [
    "kwl://app/../secret.txt",
    "kwl://app/%2e%2e/secret.txt",
    "kwl://app/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    "kwl://app/..%5c..%5csecret.txt",
    "kwl://app/index.html%00.js",
    "kwl://app/assets/x.exe",
    "kwl://app/assets/x",
    "kwl://evil/index.html",
    "file:///etc/passwd",
    "kwl://app/%E0%A4%A",
  ]) {
    const r = resolveAppFile(dist, u);
    assert.ok(r === null || r.startsWith(dist + sep), `${u} → ${r}`);
  }
  // 编码后的穿越在解码后会跳出 dist：必须不解析（而不是解析到 dist 外）
  assert.equal(resolveAppFile(dist, "kwl://app/assets/%2e%2e%2f%2e%2e%2fsecret.txt"), null);
  assert.equal(resolveAppFile(dist, "kwl://app/index.html%00.js"), null);
  const main = read("electron/main.cjs");
  assert.match(main, /registerAppScheme\(protocol\)/, "协议特权须在 ready 前登记");
  assert.match(main, /void win\.loadURL\(APP_INDEX_URL\)/);
  assert.doesNotMatch(main, /win\.loadFile\(/, "生产不得再用 loadFile（file:// 源为 null，界面空白）");
  assert.match(read("electron-builder.yml"), /grantFileProtocolExtraPrivileges:\s*false/, "熔断保持关闭");
  // 防截屏（Y5 P1-8）：敏感事项页与任务页窗口内容不进截屏与共享；随每次路由变化按内核给出的事项级别切换
  assert.match(main, /const SENSITIVE_LEVELS = new Set\(\["L3a", "L3b", "L4"\]\)/);
  assert.match(main, /win\.setContentProtection\(protect\)/);
  assert.match(main, /did-navigate-in-page/);
  assert.match(main, /wireContentProtection\(win\)/);
});

test("渲染进程 CSP：生产 default-src 'none' 起步、connect-src 'none'、不允许内联脚本；index.html 由构建注入", () => {
  const vite = read("vite.config.ts");
  assert.match(vite, /"default-src 'none'"/);
  // 开发端口可经环境变量错开（多会话并行联调）；生产仍是 connect-src 'none'
  assert.match(vite, /dev \? `connect-src 'self' http:\/\/127\.0\.0\.1:\$\{BRIDGE_PORT\} ws:\/\/127\.0\.0\.1:\$\{WEB_PORT\}` : "connect-src 'none'"/);
  assert.match(vite, /const BRIDGE_PORT = Number\(process\.env\.ZR_DEV_BRIDGE_PORT \?\? 7720\)/);
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
  // updateStatus/installUpdate：自动更新（W7）只读状态与“重启并安装”（主进程另判：主框架、已下载且通过发布签名核验）
  // pickFiles/pickSave/saveText：主进程文件对话框（Y5 P1-4），只回一次性句柄与文件名
  // pickFolder（第 14 批：备份位置、从备份恢复）：同样只回一次性句柄
  // openSaved（v9.4 第 21 批：在 Word / WPS 中打开）：只认成果保存成功后主进程发的一次性句柄，页面给不了路径
  // exportPdf（第 29 批：律师指定要 PDF）：只收成果编号；主进程向内核取打印页、选保存位置、打印并写文件，页面拿不到路径
  assert.deepEqual(exposed.sort(), ["exportPdf", "fileHandleFor", "installUpdate", "invoke", "onEvent", "openSaved", "pickFiles", "pickFolder", "pickSave", "platform", "rendererNet", "saveText", "updateStatus"].sort());
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

test("主进程转发内核广播只认白名单（复核 B4-B14）：run.updated、run.settled、kernel.event；系统通知正文只用固定文字（不含模板插值，不带事项与案情）", () => {
  const main = read("electron/main.cjs");
  // 转发分支：在 kernel.on("message") 里、排除 RPC 应答与 kernel.ready/fatal 之后，只有一处 webContents.send 转发内核消息
  const onMsg = main.slice(main.indexOf('kernel.on("message"'), main.indexOf('kernel.on("exit"'));
  const fwd = /if \(msg && \(([^)]*)\)\) \{\s*for \(const win of BrowserWindow\.getAllWindows\(\)\) win\.webContents\.send\("kwl:event", msg\);/.exec(onMsg);
  assert.ok(fwd, "转发分支须按类型白名单判断");
  assert.deepEqual([...fwd[1]!.matchAll(/msg\.type === "([^"]+)"/g)].map((m) => m[1]).sort(), ["kernel.event", "run.settled", "run.updated"]);
  assert.doesNotMatch(fwd[1]!, /typeof msg\.type/, "不得“有 type 即转发”");
  assert.equal(onMsg.match(/webContents\.send\("kwl:event", msg\)/g)?.length, 1, "内核消息只有这一处转发");
  // 通知：title 与 body 只能是字面量常量（三元选择两条固定文字可以），不得拼接或插值
  const notes = [...main.matchAll(/new Notification\(\{([^}]*)\}\)/g)].map((m) => m[1]!);
  assert.ok(notes.length > 0);
  for (const n of notes) {
    assert.doesNotMatch(n, /`|\$\{|\+/, `通知内容不得拼接：${n}`);
    const body = /body:\s*([^,]+(?:\?[^:]+:[^,]+)?)/.exec(n)?.[1] ?? "";
    for (const part of body.split(/[?:]/).slice(body.includes("?") ? 1 : 0)) assert.match(part.trim(), /^"[^"]*"$/, `通知正文只能是固定文字：${part}`);
  }
});

test("界面文字不出现工程用语（复核 B4-B23）：含中文的字符串字面量、模板字符串与 JSX 文本里没有“Agent”、G0/G1/G2（注释、标识符与 User-Agent 不算）", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk(join(root, "src"));
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const texts = [
      ...src.matchAll(/"(?:[^"\\\n]|\\.)*"/g),
      ...src.matchAll(/'(?:[^'\\\n]|\\.)*'/g),
      ...src.matchAll(/`(?:[^`\\]|\\.)*`/g),
      ...src.matchAll(/>([^<>{}]*[一-鿿][^<>{}]*)</g),
    ].map((m) => m[0]);
    for (const t of texts) if (/[一-鿿]/.test(t) && /(?<![-\w])Agent(?![-\w])|\bG[0-2]\b/.test(t)) hits.push(`${f.slice(root.length)}：${t.slice(0, 60)}`);
  }
  assert.deepEqual(hits, []);
});
