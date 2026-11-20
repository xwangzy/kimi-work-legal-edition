/**
 * 第 52 批（IP 部署）：证书类失败在执行页不说成“AI 服务连不上”；设置 → 备份与安全 有“检测连接”，文字由内核给出、界面不写研发用语。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../src/${p}`, import.meta.url)), "utf8");

test("执行页 agent.error：证书类（[kwl:tls_*] / [kwl:upstream_pins_missing]）说“加密核对未通过”，连不上照旧", async () => {
  const { buildSteps } = await import("../src/lib/timeline.ts");
  const ev = (id: number, payload: Record<string, unknown>) => ({ event_id: id, seq: id, type: "agent.error", payload, created_at: "2026-11-21T05:30:00.000Z" }) as any;
  const title = (message: string) => buildSteps([ev(1, { code: "provider.http_502", message, retryable: false })]).find((s: any) => s.level === "lawyer")?.title ?? "";
  assert.match(title("502 模型通道的证书校验未通过（可能存在网络拦截），请求已中断、未发出内容 [kwl:tls_pin_mismatch]"), /^连接云端的加密核对未通过/);
  assert.match(title("503 x [kwl:upstream_pins_missing]"), /^连接云端的加密核对未通过/);
  assert.equal(title("502 模型通道不可达（已排队或稍后重试）"), "AI 服务连不上，这一步没有完成");
});

test("连接检测：放在“备份与安全”，调用 connection.diagnose；复制给 IT 的说明只用内核给的文字", async () => {
  assert.match(src("pages/Connections.tsx"), /<ConnectionCheck \/>/);
  assert.match(src("api.ts"), /connectionDiagnose: \(\) => invoke<ConnectionDiagnosis>\("connection\.diagnose"\)/);
  const { connectionReport } = await import("../src/lib/connection-check.ts");
  const text = connectionReport({
    checked_at: "2026-11-21T05:30:00.000Z",
    gate: "running",
    tone: "error",
    conclusion: "连接云端的证书校验未通过（AI 服务）",
    rows: [{ upstream: "model", name: "AI 服务", class: "tls_pin_mismatch", label: "证书公钥与安装包内置的不符", host: "203.0.113.9", port: 443, elapsed_ms: 31, detail: null, pins: ["sha256/AAAAAAAAAAAA…"], presented: ["sha256/BBBBBBBBBBBB…"], cloud_ca: false }],
  });
  assert.match(text, /AI 服务｜203\.0\.113\.9:443｜证书公钥与安装包内置的不符｜tls_pin_mismatch｜31 ms｜内置 sha256\/AAAAAAAAAAAA…；服务器出示 sha256\/BBBBBBBBBBBB…/);
});
