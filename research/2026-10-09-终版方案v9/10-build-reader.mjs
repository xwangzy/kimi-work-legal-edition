// 离线阅读版生成器：把 v9 分篇 Markdown 合成一个自包含 HTML（目录 + 小节搜索）与一份合并 Markdown。
// 依赖 marked（无网络）。MARKED_MODULE 可指向本机已有的 marked.esm.js，例如
//   MARKED_MODULE="$HOME/Documents/Coding/MaaS 生产/new-api/web/node_modules/marked/lib/marked.esm.js" node 10-build-reader.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const { marked } = await import(process.env.MARKED_MODULE ? pathToFileURL(process.env.MARKED_MODULE).href : 'marked');

const MAIN = [
  '00-结论先行与阅读指南.md', '01-独立评审与裁决.md', '02-云地划分与权限体系.md', '03-产品方案.md',
  '04-技术架构与KimiCode集成.md', '05-合规商业与经济.md', '06-路线验收与未决事项.md',
];
const APPENDIX = [
  '审阅-对抗式-2026-10-10.md', '11-经济模型-v9-摘要.md',
  '调研-X1-主流办公Agent云地划分与权限.md', '调研-X2-沙箱KimiCode与云执行工程核验.md',
  '调研-X3-律所云端接受度与法律AI部署形态.md',
];
const files = [...MAIN, ...APPENDIX].filter((f) => fs.existsSync(path.join(root, f)));

const esc = (x) => String(x).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const plain = (x) => x.replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, ' ');
const chunks = files.map((f) => ({ file: f, md: fs.readFileSync(path.join(root, f), 'utf8') }));

const index = [];
const nav = [];
const articles = chunks.map(({ file, md }, i) => {
  let count = 0;
  const sub = [];
  let html = marked.parse(md, { gfm: true });
  html = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_, level, body) => {
    const id = `c${i}-s${count++}`;
    if (level === '2') sub.push(`<a href="#${id}">${body}</a>`);
    return `<h${level} id="${id}">${body}</h${level}>`;
  });
  html = html.replace(/<table>/g, '<div class="table" tabindex="0" aria-label="可横向滚动的表格"><table>').replace(/<\/table>/g, '</table></div>');
  html = html.replace(/<a href="(https?:[^" ]+)"/g, '<a target="_blank" rel="noopener noreferrer" href="$1"');
  for (const part of html.split(/(?=<h[2-4] id=")/)) {
    const m = part.match(/^<h[2-4] id="([^"]+)">([\s\S]*?)<\/h[2-4]>/);
    if (m) index.push({ id: m[1], title: plain(m[2]), chapter: file.replace('.md', ''), body: plain(part).slice(0, 4000) });
  }
  const kind = MAIN.includes(file) ? '主报告' : '附录';
  nav.push(`<details ${i === 0 ? 'open' : ''}><summary>${esc(file.replace('.md', ''))}</summary><a href="#chapter-${i}">本篇开头</a>${sub.join('')}</details>`);
  return `<article id="chapter-${i}"><p class="eyebrow">${kind} · ${esc(file)}</p>${html}</article>`;
});

const style = `
:root{--paper:#ffffff;--side:#fbfaf9;--ink:#0e1219;--soft:#6b7280;--line:#e6e4e1;--accent:#167ffb;--wash:#f5f4f2;--warn-bg:#fff8e9;--warn-line:#b78227;--sidew:288px}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--paper:#15171b;--side:#1b1d22;--ink:#e8eaed;--soft:#9aa0a6;--line:#2c2f36;--accent:#5aa2ff;--wash:#20232a;--warn-bg:#2a2416;--warn-line:#c9a24a}}
:root[data-theme="dark"]{--paper:#15171b;--side:#1b1d22;--ink:#e8eaed;--soft:#9aa0a6;--line:#2c2f36;--accent:#5aa2ff;--wash:#20232a;--warn-bg:#2a2416;--warn-line:#c9a24a}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:20px}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:var(--accent);text-underline-offset:3px;overflow-wrap:anywhere}p,li{overflow-wrap:anywhere}
h1,h2,h3{line-height:1.45;letter-spacing:-.01em}h1{font-size:30px}h2{font-size:23px;margin-top:40px}h3{font-size:19px;margin-top:30px}
aside{position:fixed;inset:0 auto 0 0;width:var(--sidew);background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:22px 18px;z-index:10}
aside strong{font-size:18px}aside small{color:var(--soft);display:block;font-size:12px}
#q{width:100%;padding:10px;border:1px solid var(--line);border-radius:16px;font:inherit;font-size:14px;background:var(--paper);color:var(--ink);margin:18px 0 8px}
nav{overflow:auto;flex:1}nav details{border-bottom:1px solid var(--line);font-size:13px;padding:8px 0}nav summary{cursor:pointer;font-weight:600;padding:6px 0}
nav a{display:block;padding:5px 8px 5px 16px;text-decoration:none;color:var(--soft);font-size:12px}nav a:hover{background:var(--wash);color:var(--accent)}
#results{max-height:40vh;overflow:auto}#results a{display:block;padding:8px 4px;font-size:13px;line-height:1.6;border-bottom:1px solid var(--line)}#results small{font-size:11px;color:var(--soft);display:block}
.foot{border-top:1px solid var(--line);padding-top:12px;font-size:12px;color:var(--soft)}
button{background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 12px;cursor:pointer;margin:6px 6px 0 0}
main{margin-left:var(--sidew);padding:42px 5vw 80px;max-width:1550px}
header{border-bottom:1px solid var(--line);padding-bottom:32px}.eyebrow{font-size:12px;color:var(--soft);letter-spacing:.06em}
header h1{font-size:36px;max-width:900px;margin:16px 0}header .lead{font-size:19px;max-width:900px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:20px;padding:3px 12px;font-size:12px;margin:3px;color:var(--soft)}
.pair{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin:26px 0}.card{background:var(--wash);border:1px solid var(--line);border-radius:12px;padding:18px}
.card h2{font-size:18px;margin:0 0 8px}.card p{font-size:14px;margin:8px 0}.route{font-size:13px;color:var(--accent);font-weight:600}
.notice{border-left:3px solid var(--warn-line);padding:12px 16px;background:var(--warn-bg);font-size:14px}
article{border-bottom:1px solid var(--line);padding:36px 0 44px}article h1{font-size:28px}
.table{overflow-x:auto;border:1px solid var(--line);border-radius:8px;margin:22px 0}
table{width:100%;border-collapse:collapse;min-width:690px;font-size:13px;line-height:1.75}td,th{padding:10px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{background:var(--wash)}tr:last-child td{border-bottom:0}td:first-child{min-width:110px}
code{font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--wash);padding:2px 4px;border-radius:3px;overflow-wrap:anywhere}
pre{background:var(--wash);padding:18px;border:1px solid var(--line);border-radius:8px;overflow:auto;font-size:12px;line-height:1.6}pre code{padding:0;overflow-wrap:normal;background:none}
blockquote{border-left:3px solid var(--accent);margin-left:0;padding-left:18px;color:var(--soft)}
#mobilebar{display:none}
@media(max-width:1100px){.pair{grid-template-columns:1fr}}
@media(max-width:900px){:root{--sidew:255px}main{padding:28px 24px}header h1{font-size:30px}}
@media(max-width:700px){#mobilebar{display:flex;position:sticky;top:0;z-index:20;background:var(--paper);border-bottom:1px solid var(--line);padding:10px 16px;align-items:center;justify-content:space-between}
aside{transform:translateX(-100%);top:55px;width:85vw;max-width:320px;transition:transform .2s}aside.open{transform:none}main{margin:0;padding:25px 16px}header h1{font-size:26px}article h1{font-size:24px}body{font-size:15px}h2{font-size:21px}}
@media print{aside,#mobilebar{display:none}main{margin:0;padding:0;max-width:none}header{break-after:page}article{break-before:page}.table{overflow:visible}table{min-width:0;font-size:10px}pre{white-space:pre-wrap}a{color:inherit;text-decoration:none}}
`;

const js = `
const INDEX=${JSON.stringify(index).replaceAll('<', '\\u003c')};
const q=document.getElementById('q'),result=document.getElementById('results');
q.addEventListener('input',()=>{result.replaceChildren();const n=q.value.trim().toLocaleLowerCase();if(!n)return;
const hits=INDEX.filter(x=>(x.title+' '+x.body).toLocaleLowerCase().includes(n)).slice(0,30);
for(const h of hits){const a=document.createElement('a');a.href='#'+h.id;a.textContent=h.title;const s=document.createElement('small');s.textContent=h.chapter;a.append(s);result.append(a)}
if(!hits.length)result.textContent='没有匹配的小节';});
document.querySelectorAll('a[href^="#"]').forEach(a=>a.addEventListener('click',()=>document.querySelector('aside').classList.remove('open')));
result.addEventListener('click',e=>{if(e.target.closest('a'))document.querySelector('aside').classList.remove('open')});
document.getElementById('menu').addEventListener('click',()=>document.querySelector('aside').classList.toggle('open'));
document.getElementById('print').addEventListener('click',()=>window.print());
document.getElementById('theme').addEventListener('click',()=>{const r=document.documentElement;const cur=r.getAttribute('data-theme');
const dark=cur?cur==='dark':matchMedia('(prefers-color-scheme: dark)').matches;r.setAttribute('data-theme',dark?'light':'dark')});
`;

const header = `<header><div class="eyebrow">CHINASOFT INTERNATIONAL × MOONSHOT AI · KIMI WORK LEGAL EDITION</div>
<h1>Kimi Work 法律行业发行版<br>终版方案 v9</h1>
<p class="lead">云端供给与治理，端上执行与持有；云端执行按事项授权；一套权限语义，在每一处独立强制。</p>
<div><span class="tag">独立评审 v7（opus）与 v8（astra）</span><span class="tag">只买 API token · 账号席位订阅</span><span class="tag">Kimi Code 完整接入</span><span class="tag">v9.1 · 含对抗式审阅处置</span><span class="tag">2026-10-10</span></div>
<div class="pair">
<section class="card"><h2>中软云端：供给与治理</h2><p>账号与点数、策略与审计、模型网关、检索与法源、提醒与通知、密文中继、分发更新。</p><div class="route">只买 token 拿不到的，由中软补位</div><p>不持久化客户案卷。</p></section>
<section class="card"><h2>本地事项（默认）</h2><p>材料、解析、Agent 循环、代码执行、文书与签发都在律师电脑；代码在无网的运行时隔离执行域运行（支持的 Win11 上为系统强制）；证件、账户、联系方式与自然人姓名以代号出站。</p><div class="route">桌面 → 执行域 → 出站闸门 → 网关</div><p>团队以端到端加密方式共享。</p></section>
<section class="card"><h2>云端事项（G3，按事项授权）</h2><p>律所选择托管协作的事项：境内事项库、云端执行、关机续跑、手机看内容。</p><div class="route">显式迁移 → 云端事项库 → 云端执行面</div><p>服务端可解密处理，醒目标识，不宣称不可见。</p></section>
</div>
<div class="notice">规划方案，不是生产验收证明。现有 demo 与 <code>platform/</code> 为 G0 原型；所有价格、指标、人力与周期为待试点校准的假设。</div></header>`;

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<title>Kimi Work 法律版 · 终版方案 v9</title><style>${style}</style></head><body>
<div id="mobilebar"><b>终版方案 v9</b><button id="menu">目录</button></div>
<aside><strong>Kimi Work 法律版</strong><small>终版方案 v9.1 · 2026-10-10</small>
<label for="q"><input id="q" type="search" placeholder="搜索：执行域、云端事项、kap-server、点数…" aria-label="搜索报告小节"></label>
<div id="results" aria-live="polite"></div><nav aria-label="报告目录">${nav.join('')}</nav>
<div class="foot">${files.length} 篇报告与附录 · 离线可读<br><button id="print">打印 / 存为 PDF</button><button id="theme">浅色 / 深色</button></div></aside>
<main>${header}${articles.join('')}</main><script>${js}</script></body></html>`;

fs.writeFileSync(path.join(root, 'Kimi-Work-Legal-终版方案v9-阅读版.html'), html);
fs.writeFileSync(path.join(root, '00-完整方案v9-合并版.md'),
  '# Kimi Work 法律行业发行版 · 终版方案 v9（合并版）\n\n本文件由 10-build-reader.mjs 生成，编辑请改分篇源文件后重新生成。\n\n' +
  chunks.map((x) => `<!-- SOURCE: ${x.file} -->\n\n${x.md}`).join('\n\n---\n\n'));
console.log(JSON.stringify({ chapters: files.length, search_sections: index.length, html_bytes: Buffer.byteLength(html) }));
