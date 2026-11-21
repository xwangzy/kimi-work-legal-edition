// 浏览器实测控制台登录（第 53 批）：Chromium 只信服务器证书这一把公钥（--ignore-certificate-errors-spki-list=<钉住>，不加根、不关校验）。
// 用法：node login.mjs <邮箱> <密码文件> <截图前缀>    密码只从文件读，不打印。
import { createRequire } from "node:module";
import { readFileSync, mkdirSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/playwright");
const [email, pwFile, prefix] = process.argv.slice(2);
const PIN = "0TtgzPKO3F52kRw608xdN4QJvm61ozClbcbcEjg7oJA=";
const URL0 = "https://192.168.64.20/";
const out = new URL("./shots/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: [`--ignore-certificate-errors-spki-list=${PIN}`], env: { ...process.env, HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "", NO_PROXY: "*" } });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 }, locale: "zh-CN" });
const net = [];
page.on("response", (r) => { if (r.url().includes(":8443/")) net.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
await page.goto(URL0, { waitUntil: "networkidle" });
await page.screenshot({ path: `${out}${prefix}-1-login.png` });
await page.fill('input[type="email"], input[name="email"], #email', email);
await page.fill('input[type="password"]', readFileSync(pwFile, "utf8").trim());
await page.screenshot({ path: `${out}${prefix}-2-filled.png` });
await Promise.all([page.waitForLoadState("networkidle"), page.keyboard.press("Enter")]);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}${prefix}-3-after-login.png` });
const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 600);
const mfa = /两步验证|验证码|身份验证器|动态码|绑定/.test(text);
console.log(JSON.stringify({ email, url: page.url(), mfa_prompt: mfa, text: text.slice(0, 300), net, console_errors: errs }, null, 1));
await browser.close();
