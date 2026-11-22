// 经开发桥调内核：node inv.mjs <栈目录> <成员> <方法> '<json>'
import { readFileSync } from "node:fs";
const [dir, name, method, json] = process.argv.slice(2);
const b = JSON.parse(readFileSync(`${dir}/clients/${name}/bridge.json`, "utf8"));
export async function inv(method, params) {
  const r = await fetch(`http://127.0.0.1:${b.bridge}/invoke`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${b.web}`, "x-kwl-token": b.token }, body: JSON.stringify({ method, params }) });
  return r.json();
}
if (method) console.log(JSON.stringify(await inv(method, json ? JSON.parse(json) : {}), null, 1).slice(0, Number(process.env.MAX ?? 3000)));
