/**
 * 试用构建的本机法律模型网关（trial-mode.cjs，偏离 D-160）：主进程以 utilityProcess 拉起本制品（打包时 esbuild 成
 * electron/trial-gateway.bundle.cjs），经进程消息交来 MaaS 密钥与席位签名私钥；本进程只监听 127.0.0.1，按席位令牌验签后
 * 把 legal/k3 转发到中软 MaaS（与云端网关同一份代码：上游超时、计量、点数预占）。
 *
 * 消息：主进程 → { type: "init", apiKey, upstreamBase, model, seatPrivateKeyPem, tenant, meterFile, port }
 *       本进程 → { type: "ready", port, seatToken } | { type: "failed", code }
 * 密钥只在本进程内存；计量只写元数据（不含请求内容）。也可用 child_process.fork 拉起（单测与本机核验）。
 */
import { createPrivateKey, createPublicKey } from "node:crypto";
import { createLegalGateway, fileMeter, MoonshotProvider, routesFromEnv } from "../../../services/legal-gateway/src/index.ts";
import { issueSeatToken } from "../../../packages/seat-token/src/index.ts";

const parent = process.parentPort ?? (typeof process.send === "function" ? process : null);
if (!parent) throw new Error("试用网关须由主进程拉起");
const reply = (m) => parent.postMessage ? parent.postMessage(m) : process.send(m);

let started = false;
parent.on("message", (e) => {
  const msg = e && e.data !== undefined && process.parentPort ? e.data : e;
  if (!msg || msg.type !== "init" || started) return;
  started = true;
  start(msg).catch((err) => {
    // 错误文字可能带地址：只回固定代码
    reply({ type: "failed", code: err && err.code === "EADDRINUSE" ? "port_in_use" : "start_failed" });
    setTimeout(() => process.exit(1), 50);
  });
});

async function start(o) {
  const privateKey = createPrivateKey(o.seatPrivateKeyPem);
  const keys = new Map([["trial1", createPublicKey(privateKey)]]);
  const provider = new MoonshotProvider({ apiKey: o.apiKey, baseUrl: o.upstreamBase });
  o.apiKey = null;
  const gateway = createLegalGateway({
    keys,
    provider,
    routes: routesFromEnv({ KWL_UPSTREAM_K3: o.model }),
    meter: fileMeter(o.meterFile),
    // 试用不在本机限额（额度在 MaaS 侧）；网关内部仍按请求预占与结算
    budgets: new Map([[o.tenant, 1_000_000_000_000]]),
  });
  await new Promise((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(Number(o.port ?? 0), "127.0.0.1", resolve);
  });
  // 席位令牌 30 天（应用每次启动重新签发；同一私钥，网关重启后旧令牌仍有效）
  const seatToken = issueSeatToken({ tid: o.tenant, uid: "u-trial", sid: `seat-${o.tenant}`, dev: "dev-trial", kid: "trial1" }, privateKey, 30 * 24 * 3600);
  reply({ type: "ready", port: gateway.address().port, seatToken });
}
