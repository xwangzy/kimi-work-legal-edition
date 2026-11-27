// 经开发桥调内核：node inv.mjs <网页端口> <方法> [JSON]
const [, , web, method, p] = process.argv;
const src = await fetch(`http://127.0.0.1:${web}/src/api.ts`).then((r) => r.text());
const env = JSON.parse(/import\.meta\.env = (\{[^\n]*?\});/.exec(src)[1]);
const r = await fetch(`http://127.0.0.1:${env.VITE_KWL_BRIDGE_PORT}/invoke`, { method: "POST", headers: { "content-type": "application/json", "x-kwl-token": env.VITE_KWL_BRIDGE_TOKEN, origin: `http://127.0.0.1:${web}` }, body: JSON.stringify({ method, params: p ? JSON.parse(p) : {} }) });
const d = await r.json();
console.log(JSON.stringify(d.ok ? d.result : d.error, null, 1).slice(0, Number(process.env.N || 3000)));
