// 生成单文件离线阅读版与合并 Markdown。
// 用法：MARKED_MODULE=<marked 的 lib/marked.esm.js 路径> node 10-build-reader.mjs
// 未设置 MARKED_MODULE 时尝试 import('marked')。只读取本目录的 Markdown 与经济模型结果，不访问网络。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const markedPath = process.env.MARKED_MODULE;
const { marked } = await import(markedPath ? pathToFileURL(markedPath).href : 'marked');

const chapters = [
  ['00-结论先行与阅读指南.md', '结论先行'],
  ['01-评审与裁决.md', '评审与裁决'],
  ['02-云地划分与权限体系.md', '云地划分与权限体系'],
  ['03-产品方案.md', '产品方案'],
  ['04-技术架构与研发计划.md', '技术架构与研发计划'],
  ['05-合规商业与路线.md', '合规、商业与路线'],
  ['06-附录-核验摘要与未决事项.md', '附录：核验摘要与未决事项'],
  ['审阅-对抗式-2026-10-09.md', '附录：对抗式审阅'],
  ['../2026-10-01-本地执行方案v5/03-场景交付件与验收.md', '沿用 v5：场景、交付件与验收'],
  ['../2026-10-01-本地执行方案v5/05-内容与数据资产.md', '沿用 v5：内容与数据资产'],
  ['调研-S0-KimiCode源码云依赖与可嵌入面.md', '调研 S0：Kimi Code 源码云依赖'],
  ['调研-S1-Kimi能力来源与KimiCode云依赖.md', '调研 S1：Kimi 能力来源'],
  ['调研-S2-主流Agent权限设定与本机沙箱.md', '调研 S2：主流 Agent 权限与本机沙箱'],
  ['调研-S3-检索供应商加密协作与法律市场.md', '调研 S3：检索、加密协作与法律市场'],
  ['../2026-10-02-云地划分v6/调研-R3-IM服务商应用与移动端.md', '沿用 v6 调研 R3：IM 与移动端'],
  ['../2026-10-02-云地划分v6/调研-R4-密文托管合规与律所市场.md', '沿用 v6 调研 R4：密文合规与律所市场'],
].filter(([f]) => fs.existsSync(path.join(dir, f)));

const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const strip = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();


// 中文标点紧贴 ** 时 CommonMark 不识别加粗：在代码块与行内代码之外，把 **x** 预先转为 <strong>x</strong>
const fixBold = src => src.split(/(^```[\s\S]*?^```)/m).map((seg, i) => i % 2 ? seg
  : seg.split(/(`[^`\n]*`)/).map((t, j) => j % 2 ? t : t.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')).join('')).join('');

const nav = [];
const sections = [];
const articles = chapters.map(([file, name], i) => {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  let h = 0;
  const subs = [];
  let html = marked.parse(fixBold(src), { gfm: true, breaks: false });
  html = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_, level, body) => {
    const id = `c${i}-h${++h}`;
    if (level === '2') subs.push(`<a href="#${id}">${body}</a>`);
    if (level === '2' || level === '3' || level === '4') sections.push({ id, chapter: name, title: strip(body) });
    return `<h${level} id="${id}">${body}</h${level}>`;
  });
  html = html.replace(/<table>/g, '<div class="table-wrap" tabindex="0" role="region" aria-label="表格，可横向滚动"><table>').replace(/<\/table>/g, '</table></div>');
  html = html.replace(/href="(?:\.\/)?([^"#]+\.md)"/g, (all, n) => {
    const t = chapters.findIndex(([f]) => f === decodeURIComponent(n));
    return t >= 0 ? `href="#chapter-${t}"` : all;
  });
  html = html.replace(/<a href="(https?:)/g, '<a target="_blank" rel="noopener noreferrer" href="$1');
  nav.push(`<details${i < 2 ? ' open' : ''}><summary><span class="num">${String(i).padStart(2, '0')}</span>${esc(name)}</summary><a class="chapter-start" href="#chapter-${i}">本篇开头</a>${subs.join('')}</details>`);
  const inherited = file.startsWith('../') ? '<p class="note">本篇沿用前序版本原文，未按 v7 改写；凡与 v7 第 1–5 篇冲突之处（尤其 Kimi Code 工具收敛、所内节点、共享文件夹、IM 内 H5、公开沙箱、密钥治理仪式等），以 v7 为准。</p>' : '';
  return `<article class="chapter" id="chapter-${i}" data-name="${esc(name)}"><div class="kicker">第 ${i} 篇 · ${esc(name)}</div>${inherited}${html}<p class="source-link">源文件：<code>${esc(file)}</code></p></article>`;
});

// 搜索索引：按小节切分正文纯文本
const textIndex = [];
for (const a of articles) {
  const parts = a.split(/(?=<h[2-4] id=")/);
  for (const p of parts) {
    const m = p.match(/^<h[2-4] id="([^"]+)">([\s\S]*?)<\/h[2-4]>/);
    if (!m) continue;
    textIndex.push({ id: m[1], t: strip(m[2]), b: strip(p).slice(0, 4000) });
  }
}

// 经济模型结果（情景切换）
let econ = null;
const resPath = path.join(dir, '11-经济模型-v7-results.json');
if (fs.existsSync(resPath)) {
  const r = JSON.parse(fs.readFileSync(resPath, 'utf8'));
  econ = {};
  for (const [k, s] of Object.entries(r.scenarios)) {
    econ[k] = { label: s.scenario, years: Object.fromEntries(Object.entries(s.annual).map(([y, a]) => [y, {
      seats: a.year_end_production_seats, avg: a.average_production_seats, rev: a.revenue, gm: a.gross_margin,
      op: a.operating_result, cum: a.cumulative_operating_result, cash: a.cumulative_cash, arr: a.year_end_arr,
      be: a.break_even_average_production_seats_at_this_cost_base }])), trough: s.operating_trough, cashTrough: s.cash_trough };
  }
}

const css = `
:root{--bg:#ffffff;--side:#fbfaf9;--ink:#0e1219;--muted:#6f7480;--line:#ecebe8;--accent:#167ffb;--btn:#191919;--wash:#f6f5f3;--hl:#fff7d6;--neg:#b4372f;--pos:#1f7a4d;--nav:272px;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121417;--side:#181a1e;--ink:#e8eaee;--muted:#9aa1ad;--line:#2a2e35;--accent:#4c9dff;--btn:#e8eaee;--wash:#1d2026;--hl:#3a3420;--neg:#ff8a80;--pos:#7fd3a6;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#121417;--side:#181a1e;--ink:#e8eaee;--muted:#9aa1ad;--line:#2a2e35;--accent:#4c9dff;--btn:#e8eaee;--wash:#1d2026;--hl:#3a3420;--neg:#ff8a80;--pos:#7fd3a6;color-scheme:dark}
*{box-sizing:border-box}.chapter li,.chapter p,.chapter blockquote{overflow-wrap:anywhere}.chapter li code,.chapter p code{word-break:break-all}html{scroll-padding-top:24px}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
a{color:var(--accent);text-underline-offset:3px;overflow-wrap:anywhere}
.sidebar{position:fixed;inset:0 auto 0 0;width:var(--nav);background:var(--side);border-right:1px solid var(--line);display:flex;flex-direction:column;z-index:10}
.brand{padding:22px 20px 12px}.brand b{display:block;font-size:17px;letter-spacing:-.3px}.brand span{display:block;font-size:12px;color:var(--muted);margin-top:2px}
.search{padding:0 14px 10px}.search input{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:16px;background:var(--bg);color:var(--ink);font-size:13px}
#results{max-height:40vh;overflow:auto;padding:0 10px}#results a{display:block;padding:8px;border-bottom:1px solid var(--line);font-size:12px;color:var(--ink);text-decoration:none}#results small{display:block;color:var(--muted)}#results mark{background:var(--hl);color:inherit}
.navlist{overflow:auto;flex:1;padding:4px 12px 20px}.navlist details{border-top:1px solid var(--line);padding:6px 0}.navlist summary{cursor:pointer;font-size:13px;font-weight:600;padding:6px;list-style:none}.navlist summary::-webkit-details-marker{display:none}
.num{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:8px;font-size:11px}.navlist a{display:block;font-size:12px;line-height:1.55;padding:5px 8px 5px 26px;color:var(--muted);text-decoration:none;border-radius:6px}.navlist a:hover{background:var(--wash);color:var(--ink)}.navlist .chapter-start{color:var(--accent)}
.side-foot{padding:10px 18px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);display:flex;gap:8px;align-items:center;justify-content:space-between}
.side-foot button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:8px;padding:4px 8px;font-size:11px;cursor:pointer}
.topbar{display:none}
main{margin-left:var(--nav);padding:36px 5vw 80px;min-width:0}.inner{max-width:1080px;margin:0 auto}
.cover{border-bottom:1px solid var(--line);padding-bottom:28px}.cover .eyebrow{font-size:11px;letter-spacing:1.6px;color:var(--muted);font-weight:600}.cover h1{font-size:34px;line-height:1.3;margin:14px 0;letter-spacing:-.6px}.cover p{color:var(--muted);max-width:820px}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.pills span{border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12px;color:var(--muted)}
.chapter{padding-top:48px;margin-top:12px;border-top:1px solid var(--line)}.kicker{font-size:11px;letter-spacing:1.4px;color:var(--muted);font-weight:600}
.chapter h1{font-size:27px;line-height:1.4;margin:10px 0 22px}.chapter h2{font-size:21px;line-height:1.5;margin:38px 0 14px}.chapter h3{font-size:17px;margin:28px 0 10px}.chapter h4{font-size:16px;margin:22px 0 8px}
.chapter p,.chapter li{font-size:15.5px}.chapter blockquote{margin:16px 0;padding:8px 16px;border-left:3px solid var(--accent);background:var(--wash);color:var(--muted)}
.chapter code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--wash);border-radius:4px;padding:1px 5px}
.chapter pre{overflow:auto;background:var(--wash);border:1px solid var(--line);border-radius:10px;padding:16px;font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.chapter pre code{background:none;padding:0;overflow-wrap:normal}.chapter :not(pre)>code{overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;margin:18px 0}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.7;min-width:640px}
th{background:var(--wash);text-align:left;font-weight:600;padding:9px 11px;border-bottom:1px solid var(--line);vertical-align:top}td{padding:9px 11px;border-top:1px solid var(--line);vertical-align:top}td:first-child{min-width:96px}
.source-link{font-size:12px;color:var(--muted);margin-top:24px}
.econ{margin:28px 0;border:1px solid var(--line);border-radius:14px;padding:20px;background:var(--wash)}.econ h2{margin-top:4px}
.econ .tabs{display:flex;gap:8px;margin:8px 0 14px;flex-wrap:wrap}.econ .tabs button{border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--ink);padding:5px 14px;font-size:13px;cursor:pointer}.econ .tabs button[aria-pressed="true"]{background:var(--btn);color:var(--bg);border-color:var(--btn)}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:10px 0 16px}.kpis div{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px}.kpis span{display:block;font-size:12px;color:var(--muted)}.kpis strong{font-size:20px;font-variant-numeric:tabular-nums}
.neg{color:var(--neg)}.pos{color:var(--pos)}.econ td,.econ th{text-align:right;font-variant-numeric:tabular-nums}.econ td:first-child,.econ th:first-child{text-align:left}
.bars{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;align-items:end;height:150px;margin:6px 0 4px}.bar{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;font-size:11px;color:var(--muted)}.bar i{display:block;width:60%;border-radius:6px 6px 0 0;background:var(--accent);min-height:2px}.bar i.n{background:var(--neg);border-radius:0 0 6px 6px}
.note{font-size:12px;color:var(--muted)}
@media(max-width:900px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){.sidebar{transform:translateX(-100%);transition:transform .18s;top:52px;width:86vw;max-width:320px;box-shadow:6px 0 24px #0002}.sidebar.open{transform:none}
.topbar{display:flex;position:sticky;top:0;height:52px;z-index:11;align-items:center;justify-content:space-between;background:var(--bg);border-bottom:1px solid var(--line);padding:0 16px}.topbar b{font-size:14px}.topbar button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:8px;padding:4px 10px}
main{margin-left:0;padding:20px 16px 60px}.cover h1{font-size:26px}.chapter h1{font-size:22px}.chapter h2{font-size:19px}}
@media print{.sidebar,.topbar,.search{display:none}main{margin:0;padding:0}.chapter{break-before:page}.table-wrap{overflow:visible}a{color:inherit}}
`;

const js = `
const IDX=${JSON.stringify(textIndex)};
const ECON=${JSON.stringify(econ)};
const q=document.getElementById('q'),res=document.getElementById('results');
function hl(s,w){const i=s.toLowerCase().indexOf(w.toLowerCase());if(i<0)return s.slice(0,80);const a=Math.max(0,i-30);return (a?'…':'')+s.slice(a,i).replace(/[<&]/g,'')+'<mark>'+s.slice(i,i+w.length).replace(/[<&]/g,'')+'</mark>'+s.slice(i+w.length,i+w.length+50).replace(/[<&]/g,'')+'…'}
q&&q.addEventListener('input',()=>{const w=q.value.trim();if(!w){res.innerHTML='';return}const hits=IDX.filter(x=>x.t.includes(w)||x.b.includes(w)).slice(0,30);res.innerHTML=hits.length?hits.map(x=>'<a href="#'+x.id+'"><b>'+x.t.replace(/[<&]/g,'')+'</b><small>'+hl(x.b,w)+'</small></a>').join(''):'<p class="note" style="padding:8px">没有找到</p>'});
const sb=document.querySelector('.sidebar'),tg=document.getElementById('toggle');tg&&tg.addEventListener('click',()=>sb.classList.toggle('open'));
document.querySelectorAll('.navlist a,#results').forEach(a=>a.addEventListener('click',()=>sb.classList.remove('open')));
const th=document.getElementById('theme');th&&th.addEventListener('click',()=>{const r=document.documentElement;const cur=r.getAttribute('data-theme');const next=cur==='dark'?'light':cur==='light'?'':'dark';if(next)r.setAttribute('data-theme',next);else r.removeAttribute('data-theme');th.textContent=next==='dark'?'深色':next==='light'?'浅色':'跟随系统';try{localStorage.setItem('kwl-theme',next)}catch(e){}});
try{const t=localStorage.getItem('kwl-theme');if(t){document.documentElement.setAttribute('data-theme',t);th&&(th.textContent=t==='dark'?'深色':'浅色')}}catch(e){}
function wan(x){return (x/10000).toLocaleString('zh-CN',{maximumFractionDigits:0})}
function renderEcon(k){if(!ECON)return;const s=ECON[k];document.querySelectorAll('.econ .tabs button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.k===k));
const ys=Object.keys(s.years);const y30=s.years['2030'];
document.getElementById('kpi').innerHTML='<div><span>2030 年末生产席位</span><strong>'+y30.seats.toLocaleString('zh-CN')+'</strong></div><div><span>2030 确认收入（万元）</span><strong>'+wan(y30.rev)+'</strong></div><div><span>累计经营结果谷底（万元）</span><strong class="neg">'+wan(s.trough)+'</strong></div><div><span>累计现金谷底（万元）</span><strong class="neg">'+wan(s.cashTrough)+'</strong></div>';
const mx=Math.max(...ys.map(y=>Math.abs(s.years[y].op)))||1;
document.getElementById('bars').innerHTML=ys.map(y=>{const v=s.years[y].op;const h=Math.round(Math.abs(v)/mx*100);return '<div class="bar"><span class="'+(v<0?'neg':'pos')+'">'+wan(v)+'</span><i class="'+(v<0?'n':'')+'" style="height:'+h+'%"></i>'+y+'</div>'}).join('');
document.getElementById('etable').innerHTML='<tr><th>年份</th><th>年末生产席位</th><th>平均生产席位</th><th>年末ARR</th><th>确认收入</th><th>毛利率</th><th>经营结果</th><th>累计经营结果</th><th>累计现金</th></tr>'+ys.map(y=>{const a=s.years[y];return '<tr><td>'+y+'</td><td>'+a.seats.toLocaleString('zh-CN')+'</td><td>'+a.avg.toLocaleString('zh-CN')+'</td><td>'+wan(a.arr)+'</td><td>'+wan(a.rev)+'</td><td>'+(a.gm==null?'—':(a.gm*100).toFixed(1)+'%')+'</td><td class="'+(a.op<0?'neg':'pos')+'">'+wan(a.op)+'</td><td>'+wan(a.cum)+'</td><td>'+wan(a.cash)+'</td></tr>'}).join('')}
if(ECON){document.querySelectorAll('.econ .tabs button').forEach(b=>b.addEventListener('click',()=>renderEcon(b.dataset.k)));renderEcon('base')}
`;

const econBlock = econ ? `<section class="econ" id="econ" aria-label="经济模型情景">
<div class="kicker">经济模型 · 情景切换（金额单位：万元）</div>
<h2>三种情景下的收入与经营结果</h2>
<div class="tabs" role="group" aria-label="选择情景"><button data-k="conservative" aria-pressed="false">保守</button><button data-k="base" aria-pressed="true">基准</button><button data-k="aggressive" aria-pressed="false">进取</button></div>
<div class="kpis" id="kpi"></div>
<div class="bars" id="bars" aria-hidden="true"></div>
<div class="table-wrap"><table id="etable"></table></div>
<p class="note">数据来自 <code>11-经济模型-v7-results.json</code>；累计现金按年付预收口径；所有数值是规划假设，不是预测或承诺。修改 <code>11-经济模型-v7-inputs.json</code> 后重跑模型并重新生成本页即可更新。</p>
</section>` : '';

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kimi Work 法律发行版方案</title>
<meta name="description" content="中软国际 × Kimi Work 法律行业发行版完整产品方案 v7.0（能力补位、沙箱放权：端上全能力、云上补能力、案卷在所）：评审裁决、云地划分与权限体系、产品、技术、合规商业路线与调研证据。">
<style>${css}</style></head>
<body>
<div class="topbar"><b>法律发行版方案 v7.0</b><button id="toggle" aria-label="打开目录">目录</button></div>
<aside class="sidebar" aria-label="目录">
<div class="brand"><b>Kimi Work 法律行业发行版</b><span>完整产品方案 v7.0 · 2026-10-09</span></div>
<div class="search"><input id="q" type="search" placeholder="搜索全文，例如：律所执行器" aria-label="搜索全文"></div>
<div id="results" aria-live="polite"></div>
<nav class="navlist">${nav.join('')}${econ ? '<details><summary><span class="num">≡</span>经济模型情景</summary><a class="chapter-start" href="#econ">打开情景切换</a></details>' : ''}</nav>
<div class="side-foot"><span>离线单文件 · 无外部依赖</span><button id="theme" type="button">跟随系统</button></div>
</aside>
<main><div class="inner">
<header class="cover"><div class="eyebrow">中软国际 × 月之暗面 · 立项评审材料</div>
<h1>Kimi Work 法律行业发行版<br>完整产品方案 v7.0（能力补位 · 沙箱放权）</h1>
<p>按“云端执行与本地执行的权限、功能划分有问题”“我方从 Kimi 采购的是 API token”“完整接入 Kimi Code 的后端功能、能力、特性”三点意见，在 v6.0 基础上补齐“能力来源”与“边界机制”两个维度：端上全能力、沙箱定边界；云上补能力、控制归云；案卷在所、推理过境。评审 astra 与 opus 各稿（含 v5、v6），完成 Kimi Code 源码复核与 2026-10-09 三路联网核验。所有价格、指标、人力与收入均为待试点校准的假设。</p>
<div class="pills"><span>Kimi Code 全量嵌入</span><span>事项沙箱 · 闸门唯一出口</span><span>宿主策略 · 四档 · 无完全访问</span><span>能力补位：检索 · 法源 · 遥控</span><span>案卷在所 · 推理过境</span><span>2027-04-12 公开销售</span></div>
</header>
${articles.join('\n')}
${econBlock}
<p class="note" style="margin-top:48px">本阅读版由 <code>10-build-reader.mjs</code> 从同目录 Markdown 生成；以 Markdown 为源文件修改。外部链接需联网。</p>
</div></main>
<script>${js}</script>
</body></html>`;

fs.writeFileSync(path.join(dir, 'Kimi-Work-Legal-完整方案v7-阅读版.html'), html, 'utf8');
const merged = chapters.map(([f]) => fs.readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n---\n\n');
fs.writeFileSync(path.join(dir, '00-完整方案v7-合并版.md'), `# Kimi Work 法律行业发行版 · 完整产品方案 v7.0（合并版）\n\n本文件由 10-build-reader.mjs 合并生成，编辑请修改分篇源文件。\n\n---\n\n${merged}\n`, 'utf8');
console.log(`chapters=${chapters.length} sections=${sections.length} html=${(html.length / 1024).toFixed(0)}KB`);
