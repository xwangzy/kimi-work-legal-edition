/**
 * 网关、检索等角色调用控制面时“连到另一个地址、但证书照样按控制面地址核对”（纯公网 IP 部署）。
 *
 * 场景：只有公网 IPv4、没有域名的单机试点，`control_plane.url` 写 `https://<公网IP>:8443`。不少云主机的公网 IP 不在网卡上
 * （由云平台做 1:1 NAT），本机连自己的公网 IP 要绕出去再回来（回环 NAT），有的平台不支持，网关和检索就取不到吊销集。
 * 配 `control_plane.connect_address: "127.0.0.1"` 后：TCP 连到 127.0.0.1，证书仍按 url 里的主机（公网 IP 的 IP SAN，或域名）
 * 完整校验——证书链照常验（Node 内置公共根证书 + NODE_EXTRA_CA_CERTS），主机名改由 tls.checkServerIdentity(url 主机) 核对，
 * rejectUnauthorized 始终为 true。不关任何校验。
 *
 * 只服务 url 同源的请求（其余一律报错，防止被拿去连别的地方）；不跟随跳转（调用方本来就用 redirect: "error"）。
 * 运行时只用 Node 内置模块（node:https），不引第三方依赖。
 */
import { Agent, request } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";

/**
 * @param {{ origin: string, connectAddress: string, ca?: string | Buffer | Array<string | Buffer> }} o
 *   origin：控制面来源（https://主机[:端口]）；connectAddress：实际连接的 IP 字面量；ca：只给用例用（生产走系统缺省信任）
 * @returns {typeof fetch}
 */
export function connectAddressFetch(o) {
  const base = new URL(String(o.origin));
  if (base.protocol !== "https:") throw new TypeError("connect_address 只用于 https 的控制面地址");
  const addr = String(o.connectAddress ?? "");
  if (!isIP(addr)) throw new TypeError("connect_address 须为 IP 字面量（如 127.0.0.1）");
  // url 里的主机：IPv6 去掉方括号；证书按它核对
  const certHost = base.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(base.port || 443);
  // SNI 不能带 IP（RFC 6066）：url 主机是 IP 时不发 SNI，是域名时照发
  const servername = isIP(certHost) ? "" : certHost;
  const agent = new Agent({ keepAlive: true, maxSockets: 16 });
  const verify = (_connectedHost, cert) => checkServerIdentity(certHost, cert);

  return async function fetchViaConnectAddress(input, init = {}) {
    const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (u.origin !== base.origin) throw new TypeError(`connect_address 只用于控制面 ${base.origin}，不能请求 ${u.origin}`);
    const method = String(init.method ?? "GET").toUpperCase();
    const headers = {};
    new Headers(init.headers ?? {}).forEach((v, k) => {
      headers[k] = v;
    });
    headers.host = base.host;
    let body = init.body;
    if (body !== undefined && body !== null) {
      if (typeof body === "string") body = Buffer.from(body);
      else if (body instanceof Uint8Array) body = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      else if (body instanceof ArrayBuffer) body = Buffer.from(body);
      else throw new TypeError("connect_address 的请求体只支持字符串或字节");
      headers["content-length"] = String(body.length);
    }
    init.signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      const req = request(
        {
          host: addr,
          port,
          method,
          path: `${u.pathname}${u.search}`,
          headers,
          agent,
          servername,
          checkServerIdentity: verify,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          ...(o.ca ? { ca: o.ca } : {}),
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && init.redirect !== "manual") {
            res.resume();
            reject(new TypeError(`控制面回了跳转 ${status}（connect_address 不跟随跳转）`));
            return;
          }
          const h = new Headers();
          for (let k = 0; k + 1 < res.rawHeaders.length; k += 2) h.append(res.rawHeaders[k], res.rawHeaders[k + 1]);
          const nullBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
          if (nullBody) res.resume();
          resolve(new Response(nullBody ? null : Readable.toWeb(res), { status, statusText: res.statusMessage ?? "", headers: h }));
        },
      );
      req.on("error", reject);
      req.end(body ?? undefined);
    });
  };
}

/**
 * 按配置给出调用控制面用的 fetch：没配 connect_address 时返回 undefined（各客户端用全局 fetch）。
 * @param {{ url?: string, connect_address?: unknown } | undefined} cp
 * @param {(msg: string) => never} fail
 */
export function controlPlaneFetch(cp, fail) {
  if (cp?.connect_address === undefined) return undefined;
  const addr = cp.connect_address;
  if (typeof addr !== "string" || !isIP(addr)) fail("control_plane.connect_address 须为 IP 字面量（如 127.0.0.1）：只换连接地址，证书仍按 control_plane.url 的主机核对");
  let origin;
  try {
    origin = new URL(String(cp.url)).origin;
  } catch {
    fail("control_plane.url 不是合法地址");
  }
  if (!origin.startsWith("https://")) fail("control_plane.connect_address 只用于 https 的 control_plane.url");
  return connectAddressFetch({ origin, connectAddress: addr });
}
