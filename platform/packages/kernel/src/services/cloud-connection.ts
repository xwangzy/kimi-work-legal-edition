/**
 * 连接云端的失败说明与连接检测（第 52 批（第 50 批 IP 部署虚机演练后补））。
 *
 * 演练里网关证书被换成“同一 CA、IP 对、私钥不同”与“自签”两种，客户端都正确拒绝、网关一个请求都没收到——但律师只看到
 * “AI 服务暂时不可用，这次没有取得回答：请稍后再问”，所内 IT 分不清是证书问题还是断网。IP 部署下现实的成因：Let's Encrypt 短期 IP 证书
 * 续期换了密钥（钉住不符）、服务器换了 IP（证书上的 IP 不对）、正式包连到了演示 CA 的服务器（证书不受信任）。
 *
 * - `cloudFailureKind`：按错误代码（或说明里的“[kwl:代码]”）认出证书类、安装包配置类、连不上、超时；只认代码，不按中文猜。纯函数；
 * - `cloudFailureText`：证书类与安装包配置类各一句律师话，与“连不上云端”分开；不含地址、路径、密钥与事项内容；
 * - `diagnoseView`：把闸门的连接检测结果（probe.ts）整理成设置页的表格与一句结论（文字由内核给出，界面只负责排版）。
 */
import type { ProbeItem } from "@zr-legal/egress-gate";

/** 设置里连接检测的位置（失败说明里引导 IT 去看）。 */
export const CONNECTION_CHECK_PATH = "设置 → 备份与安全 → 检测连接";

export type CloudFailureKind = "cert" | "build" | "unreachable" | "timeout";

/** 证书类：钉住不符、证书不受信任、证书上的地址不符（可带通道前缀，如 cp_、relay_、support_）。 */
const CERT_RE = /(?:^|_)tls_(?:pin_mismatch|verify_failed|name_mismatch)$/;
/** 安装包配置类：地址不是 https、缺内置钉住集、钉住值格式不对、地址不合法（构建配错，不是网络问题）。 */
const BUILD_RE = /(?:^|_)upstream_(?:tls_required|pins_missing|pins_malformed|url_invalid|url_credentials)$/;

/** 错误代码或带“[kwl:代码]”的说明 → 连接失败的类别；不是连接问题返回 null。纯函数。 */
export function cloudFailureKind(codeOrMessage: string | null | undefined): CloudFailureKind | null {
  const s = String(codeOrMessage ?? "").trim();
  const code = /\[kwl:([a-z0-9_]{1,60})\]/.exec(s)?.[1] ?? (/^[a-z0-9_]{1,60}$/.test(s) ? s : null);
  if (!code) return null;
  if (CERT_RE.test(code)) return "cert";
  if (BUILD_RE.test(code)) return "build";
  if (code === "upstream_unreachable" || code === "gate_unavailable" || code === "gate_exited" || /^[a-z]+_unreachable$|^[a-z]+_upstream_unreachable$/.test(code)) return "unreachable";
  if (code === "first_byte_timeout" || code === "stream_idle_timeout" || /^(?:cp|dist|support|notify|relay)_timeout$/.test(code)) return "timeout";
  return null;
}

/** 证书校验未通过（律师与 IT 都看这一句）。 */
export const CLOUD_CERT_TEXT = `连接云端的证书校验未通过，已中断、未发出任何内容：请联系律所 IT 或管理员（${CONNECTION_CHECK_PATH} 可查看详情）`;
/** 安装包的连接配置不完整（构建配错：地址不是加密连接或缺内置钉住）。 */
export const CLOUD_BUILD_TEXT = `这个安装包连接云端的加密设置不完整，已中断、未发出任何内容：请联系律所 IT 或管理员更换正式安装包（${CONNECTION_CHECK_PATH} 可查看详情）`;
/** 连不上云端（网络、代理、防火墙或服务器没开）。 */
export const CLOUD_UNREACHABLE_TEXT = `连不上云端，这次没有发出：请检查网络后重试；仍不行请联系律所 IT（${CONNECTION_CHECK_PATH} 可查看详情）`;
/** 云端长时间没有响应。 */
export const CLOUD_TIMEOUT_TEXT = "云端长时间没有响应，这次没有完成：请稍后重试；一直这样请联系律所 IT";

/** 证书类与安装包配置类的说明；其余返回 null（由各处原有口径处理）。 */
export function cloudFailureText(codeOrMessage: string | null | undefined): string | null {
  const k = cloudFailureKind(codeOrMessage);
  return k === "cert" ? CLOUD_CERT_TEXT : k === "build" ? CLOUD_BUILD_TEXT : null;
}

// ─── 连接检测（设置 → 备份与安全 → 检测连接） ───

const UPSTREAM_NAME: Record<string, string> = {
  control_plane: "账号与授权",
  model: "AI 服务",
  search: "联网检索",
  dist: "法规库与模板更新",
  support: "技术支持",
  notify: "期限提醒",
  relay: "同事之间同步",
};

/** 检测分类 → 一句短说明（表格“结果”列）。纯函数。 */
export function probeClassLabel(cls: string, detail?: string | null): string {
  if (cls === "ok") return "正常";
  if (cls === "unreachable") return "连不上（网络、防火墙或服务器未开）";
  if (cls === "timeout") return "超时没有响应";
  if (cls === "tls_pin_mismatch") return "证书公钥与安装包内置的不符";
  if (cls === "tls_name_mismatch") return "证书上的地址与服务器地址不符";
  if (cls === "tls_verify_failed") return "证书不受这台电脑信任";
  if (cls === "http_redirect") return "服务器要求跳转（已拒绝）";
  if (cls === "config_invalid") return `安装包的连接配置不完整（${detail ?? "upstream_tls_required"}）`;
  if (cls === "not_configured") return "未配置";
  const m = /^http_(\d{3})$/.exec(cls);
  if (m) return `能连上，服务回应异常（HTTP ${m[1]}）`;
  return "检测失败";
}

export interface DiagnoseRow {
  upstream: string;
  name: string;
  class: string;
  label: string;
  host: string | null;
  port: number | null;
  elapsed_ms: number;
  detail: string | null;
  pins: string[];
  presented: string[];
  cloud_ca: boolean;
}

export interface DiagnoseView {
  checked_at: string;
  gate: "running" | "unavailable";
  tone: "ok" | "warn" | "error";
  conclusion: string;
  rows: DiagnoseRow[];
}

const where = (r: DiagnoseRow) => (r.host ? `${r.host}${r.port ? `:${r.port}` : ""}` : "");

/**
 * 检测结果 → 设置页的表格与一句结论。顺序：安装包配置 > 证书（钉住不符 > 地址不符 > 不受信任）> 全部连不上 > 部分异常 > 正常。
 * 不写全量钉住值、密钥、令牌；主机与端口照写（IT 要据此查防火墙与证书）。纯函数。
 */
export function diagnoseView(r: { ok: true; items: ProbeItem[] } | { ok: false; reason: string }, now: Date = new Date()): DiagnoseView {
  const checked_at = now.toISOString();
  if (!r.ok) {
    return { checked_at, gate: "unavailable", tone: "error", rows: [], conclusion: "本机的连接组件没有启动，无法检测：请重启 Kimi Work；仍不行请在“遇到问题”导出诊断信息交给 IT" };
  }
  const rows: DiagnoseRow[] = r.items.map((x) => ({
    upstream: x.upstream,
    name: UPSTREAM_NAME[x.upstream] ?? x.upstream,
    class: x.class,
    label: probeClassLabel(x.class, x.detail),
    host: x.host,
    port: x.port,
    elapsed_ms: x.elapsed_ms,
    detail: x.detail,
    pins: x.pins,
    presented: x.presented,
    cloud_ca: x.cloud_ca,
  }));
  const used = rows.filter((x) => x.class !== "not_configured");
  const first = (c: string) => used.find((x) => x.class === c);
  const names = (c: string) => used.filter((x) => x.class === c).map((x) => x.name).join("、");
  const view = (tone: DiagnoseView["tone"], conclusion: string): DiagnoseView => ({ checked_at, gate: "running", tone, conclusion, rows });
  if (used.length === 0) return view("warn", "这台电脑没有配置云端服务（离线或开发形态），没有可检测的连接");
  const bad = first("config_invalid");
  if (bad) return view("error", `这个安装包的连接配置不完整（${names("config_invalid")}），相关请求一律不会发出：请联系律所 IT 或管理员更换正式安装包`);
  const pin = first("tls_pin_mismatch");
  if (pin) {
    return view(
      "error",
      `连接云端的证书校验未通过（${names("tls_pin_mismatch")}）：服务器 ${where(pin)} 出示的证书公钥与安装包内置的不符——可能是服务器换了证书密钥，也可能网络被拦截。已中断、未发出任何内容：请把本页截图发给律所 IT 或管理员`,
    );
  }
  const name = first("tls_name_mismatch");
  if (name) return view("error", `连接云端的证书校验未通过（${names("tls_name_mismatch")}）：服务器 ${where(name)} 的证书上没有这个地址——服务器地址可能变了。已中断、未发出任何内容：请把本页截图发给律所 IT 或管理员`);
  const ver = first("tls_verify_failed");
  if (ver) {
    const why = ver.cloud_ca ? "证书不是由安装包认可的机构签发" : "证书不受这台电脑信任（服务器可能用的是测试证书或自签证书，或网络被拦截）";
    return view("error", `连接云端的证书校验未通过（${names("tls_verify_failed")}）：服务器 ${where(ver)} 的${why}。已中断、未发出任何内容：请把本页截图发给律所 IT 或管理员`);
  }
  const down = used.filter((x) => x.class === "unreachable" || x.class === "timeout");
  if (down.length === used.length) {
    const hosts = [...new Set(down.map(where).filter(Boolean))].join("、");
    return view("error", `连不上云端：请检查网络、代理或防火墙是否放行 ${hosts || "云端地址"}；仍不行请联系律所 IT`);
  }
  const notOk = used.filter((x) => x.class !== "ok");
  if (notOk.length > 0) return view("warn", `部分服务不正常（${notOk.map((x) => `${x.name}：${x.label}`).join("；")}）；其余正常，证书核对通过`);
  return view("ok", "连接正常：各项云端服务都能连上，证书核对通过");
}
