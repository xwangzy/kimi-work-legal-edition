// Offline reader builder; requires marked, no network. MARKED_MODULE may point to its ESM file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
const { marked } = await import(process.env.MARKED_MODULE ? pathToFileURL(process.env.MARKED_MODULE).href : 'marked');
const files = [
  '00-决策摘要与阅读指南.md', '01-独立评审与裁决.md', '02-云地执行与权限规范.md',
  '03-产品功能与律师工作流.md', '04-KimiCode集成与工程实施.md', '05-合规运营与商业闭环.md',
  '06-研发路线与上线验收.md', '07-经济压力测算摘要.md', '08-竞品结论与证据索引.md',
  '调研-A-KimiCode与工程核验.md', '调研-B-办公Agent云地边界.md', '调研-C-法律产品合规与商业.md'
];
const esc = x => String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const plain = x => x.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g,' ');
const chunks = files.map(f => ({file:f, md:fs.readFileSync(path.join(root,f),'utf8')}));
const index = [];
const nav = [];
const articles = chunks.map(({file,md}, i) => {
  let count = 0;
  const sub = [];
  let html = marked.parse(md, {gfm:true});
  html = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_,level,body)=>{
    const id=`c${i}-s${count++}`;
    if(level==='2') sub.push(`<a href="#${id}">${body}</a>`);
    return `<h${level} id="${id}">${body}</h${level}>`;
  });
  html = html.replace(/<table>/g,'<div class="table" tabindex="0" aria-label="横向滚动表格"><table>').replace(/<\/table>/g,'</table></div>');
  html = html.replace(/<a href="(https?:[^" ]+)"/g,'<a target="_blank" rel="noopener noreferrer" href="$1"');
  for(const part of html.split(/(?=<h[2-4] id=")/)) {
    const m = part.match(/^<h[2-4] id="([^"]+)">([\s\S]*?)<\/h[2-4]>/);
    if(m) index.push({id:m[1], title:plain(m[2]), chapter:file.replace('.md',''), body:plain(part)});
  }
  nav.push(`<details ${i===0?'open':''}><summary>${esc(file.replace('.md',''))}</summary><a href="#chapter-${i}">本篇开头</a>${sub.join('')}</details>`);
  return `<article id="chapter-${i}"><p class="eyebrow">${i<9?'主报告':'独立调研附录'} · ${esc(file)}</p>${html}</article>`;
});
const style=`
:root{--paper:#fff;--ink:#18212b;--soft:#66717e;--line:#dde3e8;--blue:#2369ad;--wash:#f4f6f8;--side:285px}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:20px}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}a{color:var(--blue);text-underline-offset:3px;overflow-wrap:anywhere}p,li{overflow-wrap:anywhere}h1,h2,h3{line-height:1.45;letter-spacing:-.02em}h1{font-size:30px}h2{font-size:23px;margin-top:40px}h3{font-size:19px;margin-top:30px}
aside{position:fixed;inset:0 auto 0 0;width:var(--side);background:#f6f7f9;border-right:1px solid var(--line);display:flex;flex-direction:column;padding:22px 18px;z-index:10}aside strong{font-size:18px}aside small{color:var(--soft);display:block;font-size:12px}#q{width:100%;padding:10px;border:1px solid #cbd4de;border-radius:8px;font:inherit;font-size:14px;background:white;margin:18px 0 8px}nav{overflow:auto;flex:1}nav details{border-bottom:1px solid var(--line);font-size:13px;padding:8px 0}nav summary{cursor:pointer;font-weight:600;padding:6px 0}nav a{display:block;padding:5px 8px 5px 16px;text-decoration:none;color:var(--soft);font-size:12px}nav a:hover{background:#e8eef4;color:var(--blue)}#results{max-height:40vh;overflow:auto}#results a{display:block;padding:8px 4px;font-size:13px;line-height:1.6;border-bottom:1px solid var(--line)}#results small{font-size:11px}.foot{border-top:1px solid var(--line);padding-top:12px;font-size:12px;color:var(--soft)}button{background:white;border:1px solid #bbc7d3;border-radius:6px;padding:7px 12px;color:var(--ink);cursor:pointer}
main{margin-left:var(--side);padding:42px 5vw 80px;max-width:1550px}header{border-bottom:1px solid var(--line);padding-bottom:32px}.eyebrow{font-size:12px;color:var(--soft);letter-spacing:.06em}header h1{font-size:38px;max-width:850px;margin:16px 0}header .lead{font-size:20px;max-width:850px}.tag{display:inline-block;border:1px solid #ced7e2;border-radius:20px;padding:3px 12px;font-size:12px;margin:3px;color:var(--soft)}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:26px 0}.card{background:var(--wash);border:1px solid var(--line);border-radius:12px;padding:20px}.card h2{font-size:20px;margin:0 0 8px}.card p{font-size:14px;margin:8px 0}.route{font-size:13px;color:var(--blue);font-weight:600}.notice{border-left:3px solid #b78227;padding:12px 16px;background:#fff8e9;font-size:14px}
article{border-bottom:1px solid var(--line);padding:36px 0 44px}article h1{font-size:29px}.table{overflow-x:auto;border:1px solid var(--line);border-radius:8px;margin:22px 0}table{width:100%;border-collapse:collapse;min-width:690px;font-size:13px;line-height:1.75}td,th{padding:11px 13px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{background:var(--wash)}tr:last-child td{border-bottom:0}td:first-child{min-width:125px}code{font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--wash);padding:2px 4px;border-radius:3px;overflow-wrap:anywhere}pre{background:var(--wash);padding:18px;border:1px solid var(--line);border-radius:8px;overflow:auto;font-size:12px;line-height:1.7}pre code{padding:0;overflow-wrap:normal}blockquote{border-left:3px solid var(--blue);margin-left:0;padding-left:18px;color:var(--soft)}#mobilebar{display:none}.target-flash{background:#fff3bc;transition:background 2s}
@media(max-width:900px){:root{--side:255px}main{padding:28px 24px}header h1{font-size:30px}.pair{grid-template-columns:1fr}}
@media(max-width:700px){#mobilebar{display:flex;position:sticky;top:0;z-index:20;background:white;border-bottom:1px solid var(--line);padding:10px 14px;align-items:center;justify-content:space-between}aside{transform:translateX(-100%);top:55px;width:85vw;max-width:320px}aside.open{transform:none}main{margin:0;padding:25px 18px}header h1{font-size:28px}article h1{font-size:25px}body{font-size:15px}h2{font-size:21px}}
@media print{aside,#mobilebar{display:none}main{margin:0;padding:0;max-width:none}header{break-after:page}article{break-before:page}.table{overflow:visible}table{min-width:0;font-size:10px}pre{white-space:pre-wrap}a{color:inherit;text-decoration:none}.pair{grid-template-columns:1fr 1fr}}
`;
const js=`
const INDEX=${JSON.stringify(index).replaceAll('<','\\u003c')};
const q=document.getElementById('q'), result=document.getElementById('results');
q.addEventListener('input',()=>{result.replaceChildren();const needle=q.value.trim().toLocaleLowerCase();if(!needle)return;const hits=INDEX.filter(x=>(x.title+' '+x.body).toLocaleLowerCase().includes(needle)).slice(0,30);for(const hit of hits){const a=document.createElement('a');a.href='#'+hit.id;a.textContent=hit.title;const s=document.createElement('small');s.textContent=hit.chapter;a.append(s);result.append(a)}if(!hits.length)result.textContent='没有匹配的小节';});
document.querySelectorAll('a[href^="#"]').forEach(a=>a.addEventListener('click',()=>document.querySelector('aside').classList.remove('open')));
result.addEventListener('click',e=>{if(e.target.closest('a'))document.querySelector('aside').classList.remove('open')});
document.getElementById('menu').addEventListener('click',()=>document.querySelector('aside').classList.toggle('open'));
document.getElementById('print').addEventListener('click',()=>window.print());
`;
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><title>Kimi Work 法律行业发行版 · 独立终审 v8</title><style>${style}</style></head><body><div id="mobilebar"><b>独立终审 v8</b><button id="menu">目录</button></div><aside><strong>Kimi Work 法律版</strong><small>独立终审 · 2026-10-09</small><label for="q"><input id="q" type="search" placeholder="搜索权限、V7、签发、成本…" aria-label="搜索报告小节"></label><div id="results" aria-live="polite"></div><nav aria-label="报告目录">${nav.join('')}</nav><div class="foot">12篇报告与调研 · 离线可读<br>建议基线，尚非生产验收证明<br><button id="print">打印 / 存为PDF</button></div></aside><main><header><div class="eyebrow">CHINASOFT INTERNATIONAL · INDEPENDENT REVIEW</div><h1>Kimi Work 法律行业发行版<br>独立终审与可实施方案 v8</h1><p class="lead">桌面为主，账号订阅。以事项授权决定云地执行，以可复核的律师交付件定义完整。</p><div><span class="tag">Astra / Opus / V5 / V6 / V7</span><span class="tag">内地律师</span><span class="tag">证据与建议分开</span></div><div class="pair"><section class="card"><h2>L · 本地保密事项</h2><p>材料与派生正文留在获准客户设备；代码在已验收的本机沙箱执行。获准的模型输入仍会发往API。</p><div class="route">桌面 → 本机工具 → 受控模型网关</div><p>无获准在线执行器时，关机后内容任务等待。</p></section><section class="card"><h2>C · 标准协作事项</h2><p>明确授权的材料托管境内，云沙箱可持续执行；桌面负责本机文件与Office，团队可跨设备审阅。</p><div class="route">显式上传 → 境内事项库 → 云任务 / 审阅</div><p>服务端会解密处理，不能宣传端到端不可见。</p></section></div><div class="notice">本报告未改造或部署产品。现有demo仍需修复权限、隔离与任务终态等问题，并通过合同、法律质量、安全和运营验收，才可按对应范围商用。</div></header>${articles.join('')}</main><script>${js}</script></body></html>`;
fs.writeFileSync(path.join(root,'Kimi-Work-Legal-v8-独立终审阅读版.html'),html);
fs.writeFileSync(path.join(root,'Kimi-Work-Legal-v8-完整合并报告.md'), '# Kimi Work 法律行业发行版 · 独立终审v8完整报告\n\n本文件由09-build-reader.mjs生成，以同目录分篇源文件为编辑来源。\n\n'+chunks.map(x=>`<!-- SOURCE: ${x.file} -->\n\n${x.md}`).join('\n\n---\n\n'));
console.log(JSON.stringify({chapters:files.length,search_sections:index.length,html_bytes:Buffer.byteLength(html)}));
