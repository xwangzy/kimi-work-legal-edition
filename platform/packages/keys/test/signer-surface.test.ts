/**
 * KP-02 签名面静态门禁（TPM 与根私钥离线分持设计 v1 §7.4 第 1 项）：
 * - 生产源码里设备签名私钥（signPrivateKeyPem）只出现在密钥文件读写、设备恢复与签名者/证书实现中；其余一律经签名者；
 * - 不经分派直接 sign(null…)/verify(null…) 的只有既定的 Ed25519 专用密钥（控制面信封、席位令牌、根的开通证明、发布签名）——
 *   设备签名一律经 signing.ts 分派（Ed25519 或 P-256 低 S）。新增调用点即失败，须先确认属于哪一类。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      if (["node_modules", "test", "vendor", "dist", "eval"].includes(n)) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs|cjs)$/.test(n) && !/bundle|\.d\.ts$/.test(n)) out.push({ rel: relative(ROOT, p).split("\\").join("/"), text: readFileSync(p, "utf8") });
    }
  };
  for (const d of ["packages", "services", "apps/firm-node/src", "apps/desktop/electron"]) walk(join(ROOT, d));
  return out.filter((f) => f.rel.includes("/src/") || f.rel.startsWith("apps/desktop/electron/"));
}

/**
 * 允许出现设备签名私钥字段的文件、出现次数与理由。次数钉死（复核 S7A-02）：豁免文件里新增一处也失败，须先确认用途。
 */
const PRIVATE_PEM_ALLOWED: Record<string, { count: number; why: string }> = {
  "packages/keys/src/device.ts": { count: 2, why: "生成设备密钥（DeviceKeys 字段定义）" },
  "packages/keys/src/signer.ts": { count: 1, why: "签名者实现（只在对象内持有 KeyObject）" },
  "packages/kernel/src/devices.ts": { count: 7, why: "密钥文件读写、暂存的设备恢复、拆出签名者（DeviceContext 不常驻签名私钥）" },
  "packages/kernel/src/api/index.ts": { count: 8, why: "设备恢复包导出与导入（recovery.*，从密钥文件读取）" },
  "packages/kernel/src/services/recovery-package.ts": { count: 1, why: "整机恢复包（第 14 批）：从密钥文件读出设备私钥封入恢复码包裹的恢复包（只核对私钥存在）" },
  "packages/firm-trust/src/request-auth.ts": { count: 2, why: "测试与工具的私钥 PEM 入口（内核传签名者）" },
};

/** 允许直接 sign(null…)/verify(null…) 的 Ed25519 专用密钥。 */
const RAW_ED25519_ALLOWED: Record<string, string> = {
  "packages/keys/src/signing.ts": "分派实现本身",
  "packages/firm-trust/src/envelope.ts": "控制面签名信封（控制面密钥，非设备密钥）",
  "packages/seat-token/src/index.ts": "席位令牌（控制面席位密钥）",
  "packages/kernel/src/control-plane/client.ts": "开通证明（律所根私钥，根保持 Ed25519，偏离 D-69）",
  "services/control-plane/src/server.ts": "开通证明核验（律所根公钥）",
  "apps/desktop/electron/update-verify.cjs": "发布清单签名（发布密钥）",
};

test("KP-02 设备签名私钥只在密钥文件、恢复与签名者实现里出现；其余代码只拿签名者", () => {
  const hits = sources().filter((f) => f.text.includes("signPrivateKeyPem"));
  assert.deepEqual(hits.map((f) => f.rel).filter((r) => !PRIVATE_PEM_ALLOWED[r]), [], "新增的私钥 PEM 传递点");
  for (const f of hits) assert.equal(f.text.split("signPrivateKeyPem").length - 1, PRIVATE_PEM_ALLOWED[f.rel]!.count, `${f.rel} 里私钥 PEM 的出现次数变了`);
  assert.ok(hits.some((f) => f.rel === "packages/kernel/src/devices.ts"), "扫描本身有效");
  // 按私钥签名的原语只在 keys 包内使用；其余代码经签名者（复核 S7A-02）
  assert.deepEqual(sources().filter((f) => !f.rel.startsWith("packages/keys/src/") && /\b(?:signBytes|signWithKey)\(/.test(f.text)).map((f) => f.rel), [], "keys 包外直接按私钥签名");
  // 内核的签名调用点都经签名者：账本、出站批准、同步段、删除回执、归档、诊断、审批、控制面请求
  const kernel = sources().filter((f) => f.rel.startsWith("packages/kernel/src/"));
  assert.deepEqual(kernel.filter((f) => /\bsignBytes\(/.test(f.text)).map((f) => f.rel), [], "内核不再直接用私钥 PEM 签名");
});

test("KP-02 不经分派的 sign(null…)/verify(null…) 只在既定的 Ed25519 专用密钥处", () => {
  // 任何别名或命名空间下的 sign/verify(null, …)（复核 S7A-10：原正则只认几个固定名字）
  const re = /\b(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$]*(?:[Ss]ign|[Vv]erify)\(\s*null\s*,/;
  const hits = sources().filter((f) => re.test(f.text)).map((f) => f.rel);
  assert.deepEqual(hits.filter((r) => !RAW_ED25519_ALLOWED[r]), [], "新增的未分派签名或验签");
  for (const r of Object.keys(RAW_ED25519_ALLOWED)) assert.ok(hits.includes(r), `允许表过时（${r} 已不再直接调用）：请同步`);
});
