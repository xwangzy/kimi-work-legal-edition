// 带故障注入的延迟 TCP 转发（在 delay-proxy.mjs 之上认 HTTP 请求行）：
//   node fault-proxy.mjs <监听>:<目标> ... --delay 150 --handshake 1 --control <控制文件.json> --log <日志>
// 控制文件（每个新请求读一次，驱动在要注入的那一刻写入；gen 变了计数重来）：
//   { "gen": 3, "fail503": { "/v1/devices/register": 3 }, "hang": ["/v1/auth/devices/enroll"] }
//   fail503：该路径的前 N 次请求不转发，延迟 delay 后回 503（Connection: close）；
//   hang：该路径的请求不转发、永不回包（连接保持打开，直到客户端自己断开）——云端根本收不到这次请求。
import net from "node:net";
import { appendFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const delay = Number(opt("--delay", "150"));
const hs = Number(opt("--handshake", "1"));
const logf = opt("--log", null);
const ctlf = opt("--control", null);
const maps = argv.filter((a) => /^\d+:\d+$/.test(a)).map((s) => s.split(":").map(Number));
const log = (o) => { if (logf) appendFileSync(logf, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); };
const used = new Map();
const control = () => { try { return JSON.parse(readFileSync(ctlf, "utf8")); } catch { return { gen: 0 }; } };
const REQ = /^(GET|POST|PUT|DELETE|PATCH) (\/[^ ?]*)(?:\?[^ ]*)? HTTP\/1\.[01]\r\n/;
function decide(path) {
  const c = control();
  if ((c.hang ?? []).includes(path)) return "hang";
  const n = c.fail503?.[path] ?? 0;
  const k = `${c.gen}\u0000${path}`;
  if (n > 0 && (used.get(k) ?? 0) < n) { used.set(k, (used.get(k) ?? 0) + 1); return `503#${used.get(k)}`; }
  return "pass";
}
let seq = 0;
for (const [lp, tp] of maps) {
  net.createServer((c) => {
    const id = ++seq, t0 = Date.now();
    const up = net.connect(tp, "127.0.0.1");
    let mode = "pass";
    const q = { cu: [], uc: [] }, timer = { cu: null, uc: null };
    const pipe = (dir, to) => {
      const flush = () => { timer[dir] = null; const now = Date.now(); while (q[dir].length && q[dir][0].due <= now) { const x = q[dir].shift(); if (x.end) to.end(); else if (!to.destroyed) to.write(x.d); } if (q[dir].length) timer[dir] = setTimeout(flush, q[dir][0].due - now); };
      return (x) => { q[dir].push(x); if (!timer[dir]) timer[dir] = setTimeout(flush, Math.max(0, q[dir][0].due - Date.now())); };
    };
    const toUp = pipe("cu", up), toC = pipe("uc", c);
    const firstAt = t0 + hs * 2 * delay + delay;
    c.on("data", (d) => {
      if (mode === "hang" || mode === "503") return;
      const m = REQ.exec(d.subarray(0, 300).toString("latin1"));
      if (m) {
        const act = decide(m[2]);
        if (act === "hang") { mode = "hang"; up.destroy(); log({ id, port: tp, path: m[2], action: "hang" }); return; }
        if (act.startsWith("503")) {
          mode = "503"; up.destroy();
          const body = JSON.stringify({ error: { code: "service_unavailable", message: "（测试注入）服务暂时不可用" } });
          const resp = `HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
          setTimeout(() => { if (!c.destroyed) c.end(resp); }, Math.max(2 * delay, firstAt + delay - Date.now()));
          log({ id, port: tp, path: m[2], action: act });
          return;
        }
      }
      toUp({ d, due: Math.max(Date.now() + delay, firstAt) });
    });
    c.on("end", () => { if (mode === "pass") toUp({ end: true, due: Math.max(Date.now() + delay, firstAt) }); });
    up.on("data", (d) => { if (mode === "pass") toC({ d, due: Date.now() + delay }); });
    up.on("end", () => { if (mode === "pass") toC({ end: true, due: Date.now() + delay }); });
    up.on("error", () => { if (mode === "pass") c.destroy(); });
    c.on("error", () => up.destroy());
    c.on("close", () => { up.destroy(); log({ id, port: tp, ms: Date.now() - t0, mode }); });
  }).listen(lp, "127.0.0.1", () => console.log(`[fault-proxy] 127.0.0.1:${lp} → :${tp}，单程 ${delay} ms，控制文件 ${ctlf}`));
}
