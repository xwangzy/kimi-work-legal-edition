// 延迟 TCP 转发：node delay-proxy.mjs <监听端口>:<目标端口> ... [--delay 150] [--handshake 1] [--log 文件]
// 每个方向每块数据延迟 --delay 毫秒（往返 = 2×delay）；新连接的第一块上行数据另加 --handshake 个往返（模拟 TCP 三次握手；明文 HTTP，未模拟 TLS）。
// 同方向按到达顺序转发（到期时刻单调），连接级日志（新连接时刻、目标端口、上下行字节数）写 --log。
import net from "node:net";
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const delay = Number(opt("--delay", "150"));
const hs = Number(opt("--handshake", "1"));
const logf = opt("--log", null);
const maps = argv.filter((a) => /^\d+:\d+$/.test(a)).map((s) => s.split(":").map(Number));
const log = (o) => { if (logf) appendFileSync(logf, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n"); };
let seq = 0;
function delayedPipe(from, to, firstAt, count) {
  const q = [];
  let timer = null;
  const flush = () => {
    timer = null;
    const now = Date.now();
    while (q.length && q[0].due <= now) {
      const x = q.shift();
      if (x.end) to.end();
      else if (!to.destroyed) to.write(x.d);
    }
    if (q.length) timer = setTimeout(flush, q[0].due - now);
  };
  const push = (x) => { q.push(x); if (!timer) timer = setTimeout(flush, Math.max(0, q[0].due - Date.now())); };
  from.on("data", (d) => { count.n += d.length; push({ d, due: Math.max(Date.now() + delay, firstAt) }); });
  from.on("end", () => push({ end: true, due: Math.max(Date.now() + delay, firstAt) }));
}
for (const [lp, tp] of maps) {
  net
    .createServer((c) => {
      const id = ++seq;
      const t0 = Date.now();
      const up = net.connect(tp, "127.0.0.1");
      const cu = { n: 0 }, uc = { n: 0 };
      // 上行第一块数据最早在 握手往返 + 单程 之后到达服务端
      delayedPipe(c, up, t0 + hs * 2 * delay + delay, cu);
      delayedPipe(up, c, 0, uc);
      const done = () => { if (!done.x) { done.x = 1; log({ id, port: tp, ms: Date.now() - t0, up: cu.n, down: uc.n }); } };
      for (const s of [c, up]) { s.on("error", () => { c.destroy(); up.destroy(); }); s.on("close", done); }
      log({ id, port: tp, open: true });
    })
    .listen(lp, "127.0.0.1", () => console.log(`[delay-proxy] 127.0.0.1:${lp} → :${tp}，单程 ${delay} ms，握手 ${hs} 个往返`));
}
