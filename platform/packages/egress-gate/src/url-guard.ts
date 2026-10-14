/**
 * 抓取 URL 检查（第 02 篇 §8.3 URL 行、§7.3 #32；第 04 篇 §5.1 `/fetch` 行、§2 网页抓取行）：
 *
 * - 只 http(s)、只 GET；不带用户名口令；端口只 80/443（或显式 8080/8443）；
 * - 搜索引擎与回显查询参数的站点不经抓取访问（查询应走检索服务，带去标识）；
 * - URL 中的当事人实体、证件/账户/联系方式类标识符、自然人姓名与可疑长编码串一律拦截（URL 不得携带事项信息）；
 * - SSRF：主机名解析出的每个地址都必须是公网地址——私网、回环、链路本地（含云元数据 169.254.169.254）、CGNAT、组播、保留、
 *   IPv4 映射/NAT64/6to4 里嵌入的上述地址一律拒绝；连接钉在已校验的地址上（防 DNS 重绑定）；每次重定向重新校验。
 */
import { BlockList, isIP } from "node:net";
import { domainToUnicode } from "node:url";
import { residualIdentifiers, TOKEN_RE, type MatterTokenizer } from "@zr-legal/tokenizer";

const BLOCKED = new BlockList();
// IPv4
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
// IPv6
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4 兼容地址 ::a.b.c.d、NAT64 本地前缀、Teredo（审查 S4-09）
  ["::", 96],
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["100::", 64],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** IPv6 中嵌入的 IPv4（映射 ::ffff:a.b.c.d、NAT64 64:ff9b::/96、6to4 2002::/16、兼容 ::a.b.c.d）。 */
function embeddedV4(ip6: string): string | null {
  const lower = ip6.toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted && (lower.startsWith("::ffff:") || lower.startsWith("64:ff9b::") || /^::(?:\d)/.test(lower))) return dotted[1]!;
  const groups = expandV6(lower);
  if (!groups) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // ::ffff:hhhh:hhhh
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) return v4(groups[6]!, groups[7]!);
  // 64:ff9b::/96
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return v4(groups[6]!, groups[7]!);
  // 2002:wwxx:yyzz::/48
  if (groups[0] === 0x2002) return v4(groups[1]!, groups[2]!);
  return null;
}

function expandV6(ip: string): number[] | null {
  const noZone = ip.split("%")[0]!;
  let head: string[];
  let tail: string[];
  if (noZone.includes("::")) {
    const [h, t] = noZone.split("::");
    head = h ? h.split(":") : [];
    tail = t ? t.split(":") : [];
  } else {
    head = noZone.split(":");
    tail = [];
  }
  const toNums = (xs: string[]) => {
    const out: number[] = [];
    for (const x of xs) {
      if (x.includes(".")) {
        const p = x.split(".").map(Number);
        if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((p[0]! << 8) | p[1]!, (p[2]! << 8) | p[3]!);
      } else {
        const n = Number.parseInt(x, 16);
        if (!/^[0-9a-f]{1,4}$/.test(x) || Number.isNaN(n)) return null;
        out.push(n);
      }
    }
    return out;
  };
  const h = toNums(head);
  const t = toNums(tail);
  if (!h || !t) return null;
  const fill = 8 - h.length - t.length;
  if (fill < 0 || (!noZone.includes("::") && fill !== 0)) return null;
  return [...h, ...new Array<number>(fill).fill(0), ...t];
}

/** 地址是否为公网可达地址（不在任何保留、私网、回环、链路本地范围内）。 */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return !BLOCKED.check(ip, "ipv4");
  if (kind === 6) {
    if (BLOCKED.check(ip, "ipv6")) return false;
    const v4 = embeddedV4(ip);
    if (v4 && BLOCKED.check(v4, "ipv4")) return false;
    return true;
  }
  return false;
}

/** 搜索引擎与回显查询的站点：查询必须走检索服务（经去标识），不经抓取。 */
const SEARCH_AND_ECHO_HOSTS = [
  "google.com", "google.com.hk", "bing.com", "cn.bing.com", "baidu.com", "sogou.com", "so.com", "duckduckgo.com", "yandex.com", "yahoo.com",
  "sm.cn", "toutiao.com", "zhihu.com/search", "httpbin.org", "postman-echo.com", "webhook.site", "requestbin.com", "pipedream.net",
  "beeceptor.com", "ngrok.io", "ngrok-free.app", "interact.sh", "oast.fun", "burpcollaborator.net", "dnslog.cn", "ceye.io",
];

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string; detail?: string };

const MAX_URL_LENGTH = 2048;

function hostMatches(host: string, entry: string): boolean {
  const h = entry.split("/")[0]!;
  return host === h || host.endsWith(`.${h}`);
}

/**
 * 静态检查（不解析域名）：scheme、口令、端口、长度、搜索引擎与回显站点、URL 中的标识符/姓名/当事人/长编码串。
 * tokenizer 为本事项的令牌化器（当事人词典与已知姓名）；没有事项上下文时只做结构检查。
 */
export const DEFAULT_ALLOWED_PORTS: readonly number[] = Object.freeze([80, 443, 8080, 8443]);

export function checkUrlStatic(raw: string, tokenizer?: MatterTokenizer, allowedPorts: readonly number[] = DEFAULT_ALLOWED_PORTS): UrlVerdict {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "url_missing" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "url_too_long" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "url_invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme_not_allowed", detail: url.protocol };
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!allowedPorts.includes(port)) return { ok: false, reason: "port_not_allowed", detail: String(port) };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".kwl")) {
    return { ok: false, reason: "host_not_public", detail: host };
  }
  if (isIP(host) && !isPublicAddress(host)) return { ok: false, reason: "address_not_public", detail: host };
  // 十进制、八进制、十六进制的数字主机名（http://2130706433/）：拒绝
  if (/^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+)){0,3}$/i.test(host) && !isIP(host)) return { ok: false, reason: "numeric_host_not_allowed", detail: host };
  const pathAndQuery = `${url.pathname}${url.search}`;
  for (const e of SEARCH_AND_ECHO_HOSTS) {
    if (hostMatches(host, e) && (!e.includes("/") || url.pathname.startsWith(`/${e.split("/").slice(1).join("/")}`))) {
      return { ok: false, reason: "search_or_echo_site", detail: host };
    }
  }
  // URL 中不得携带事项信息：迭代解码到稳定（多重百分号编码，审查 S4-09）后检查标识符、事项代号、当事人与已知姓名、可疑长编码串；
  // 主机名的各标签转回 Unicode 后同样检查（IDN 标签里的姓名会随 DNS 查询发给白名单域的权威服务器）
  let decoded = pathAndQuery;
  for (let i = 0; i < 4; i++) {
    let next = decoded;
    try {
      next = decodeURIComponent(decoded.replace(/\+/g, " "));
    } catch {
      break; // 非法编码按当前结果检查
    }
    if (next === decoded) break;
    decoded = next;
  }
  const hostText = domainToUnicode(host) || host;
  const subject = `${hostText} ${decoded}`;
  if (residualIdentifiers(decoded).length > 0) return { ok: false, reason: "identifier_in_url" };
  TOKEN_RE.lastIndex = 0;
  if (TOKEN_RE.test(subject)) {
    TOKEN_RE.lastIndex = 0;
    return { ok: false, reason: "token_in_url" };
  }
  TOKEN_RE.lastIndex = 0;
  if (tokenizer) {
    const r = tokenizer.tokenize(subject);
    if ((r.counts.person ?? 0) > 0) return { ok: false, reason: "person_name_in_url" };
    if (tokenizer.findParties(subject).length > 0) return { ok: false, reason: "party_entity_in_url" };
  }
  if (/[A-Za-z0-9+/_-]{48,}={0,2}/.test(decoded.replace(/\//g, " ")) || /[0-9a-f]{40,}/i.test(decoded)) {
    return { ok: false, reason: "encoded_payload_in_url" };
  }
  if (url.hash) url.hash = "";
  return { ok: true, url };
}
