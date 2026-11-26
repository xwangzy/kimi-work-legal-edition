// 导出隔离核对：抓界面发往开发桥的请求（地址、令牌、成果版本号），再直接调 artifacts.download / artifacts.print_html，落盘比对
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const require = createRequire("/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/");
const { chromium } = require("playwright");
const out = process.argv[2];
mkdirSync(out, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
let bridge = null;
const ids = new Map();
let pendingName = "起诉状.docx";
p.on("request", (r) => {
  if (r.method() !== "POST") return;
  const body = r.postData() ?? "";
  if (!/"method"/.test(body)) return;
  bridge ??= { url: r.url(), token: r.headers()["x-kwl-token"] };
  const m = /"artifact_version_id":"(artv_[A-Za-z0-9_-]+)"/.exec(body);
  if (m && pendingName && !ids.has(pendingName)) ids.set(pendingName, m[1]);
});
await p.goto("http://127.0.0.1:5692/#/deliverables");
await p.waitForSelector(".dl-row");
await p.waitForTimeout(1200);
for (const [name, re] of [["起诉状.docx", /^W 民事起诉状/], ["证据目录.xlsx", /^X 证据目录/]]) {
  pendingName = name;
  for (const r of await p.$$(".dl-row")) {
    if (re.test((await r.innerText()).replace(/\s+/g, " "))) {
      await r.click();
      break;
    }
  }
  await p.waitForTimeout(2000);
}
const call = async (method, params) => {
  const d = await p.evaluate(async ([u, t, body]) => (await fetch(u, { method: "POST", headers: { "content-type": "application/json", ...(t ? { "x-kwl-token": t } : {}) }, body })).json(), [bridge.url, bridge.token, JSON.stringify({ method, params })]);
  if (!d.ok) throw new Error(method + " " + JSON.stringify(d.error));
  return d.result;
};
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const report = [];
for (const [name, id] of ids) {
  const a = await call("artifacts.download", { artifact_version_id: id });
  const b2 = await call("artifacts.download", { artifact_version_id: id });
  const bufA = Buffer.from(a.data_base64, "base64");
  const bufB = Buffer.from(b2.data_base64, "base64");
  writeFileSync(`${out}/${name}`, bufA);
  report.push({ name, id, filename: a.filename, bytes: bufA.length, sha256: sha(bufA), kernelSha: a.sha256 ?? null, secondDownloadSame: sha(bufB) === sha(bufA) });
  if (name.endsWith(".docx")) {
    const ph = await call("artifacts.print_html", { artifact_version_id: id });
    writeFileSync(`${out}/print.html`, ph.html);
    const leak = /efedea|161514|radial-gradient|kwl-paper|preview-canvas|box-shadow/i.exec(ph.html);
    report.push({ print_html: ph.filename, bytes: ph.html.length, sha256: sha(Buffer.from(ph.html)), previewStyleLeak: leak ? leak[0] : null, bodyBg: /html,body\{[^}]*background:[^;}]+/.exec(ph.html)?.[0] ?? null });
  }
}
console.log(JSON.stringify({ bridge: bridge.url, report }, null, 1));
await b.close();
