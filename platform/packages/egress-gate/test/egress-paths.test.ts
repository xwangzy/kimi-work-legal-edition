/**
 * 驻留面门禁：闸门通道与外发路径逐条登记（v9.3 A-12 余项；评审 Z4 P0-11“通道 ↔ 清单”、R29）。
 * 闸门每个外发通道的源码里，发往云端的路径（控制面白名单正则、分发正则、通知 / 中继 / 支持拼出的路径、模型与问答的路径后缀）
 * 必须与 docs/privacy/egress-paths.json 逐条一致，登记的数据类编号须存在于驻留面清单——新加一条外发路径不登记即失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(`${root}${rel}`, "utf8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");

/** 从源码取外发路径（按文件的写法分四类）。 */
export function outboundPaths(rel: string, src: string): string[] {
  const code = stripComments(src);
  if (rel.endsWith("cp-relay.ts")) {
    const block = /const PATHS: readonly RegExp\[\] = \[([\s\S]*?)\];/.exec(code)?.[1] ?? "";
    return [...block.matchAll(/^\s*\/(\^[^\n]*?\$)\/,?\s*$/gm)].map((m) => m[1]!);
  }
  if (rel.endsWith("dist-relay.ts")) return [...code.matchAll(/const PATH_RE = \/(\^[^\n]*?\$)\/;/g)].map((m) => m[1]!);
  if (rel.endsWith("server.ts")) return [...code.matchAll(/`\$\{[^}`]*baseUrl[^}`]*\}(\/[^`$]*)`/g)].map((m) => m[1]!);
  // 通知、中继、支持：path = "…" / `…`；模板里的 ${…} 记作 {}
  return [...code.matchAll(/\bpath = (?:"([^"\n]*)"|`([^`\n]*)`);/g)].map((m) => (m[1] ?? m[2]!).replace(/\$\{(?:[^{}]|\{[^}]*\})*\}/g, "{}"));
}

const registry = JSON.parse(read("docs/privacy/egress-paths.json")) as { channels: Record<string, { what: string; classes: number[]; paths: string[] }> };
const residency = JSON.parse(read("docs/privacy/residency.json")) as { rows: { id: number }[] };

test("闸门外发通道逐条登记：每个通道源码里的外发路径与登记表一致（多一条、少一条都失败）", () => {
  const channels = Object.keys(registry.channels);
  assert.ok(channels.length >= 6, "通道太少：登记表可能被误删");
  for (const rel of channels) {
    const got = [...new Set(outboundPaths(rel, read(rel)))].sort();
    const want = [...new Set(registry.channels[rel]!.paths)].sort();
    assert.ok(got.length > 0, `${rel}：一条外发路径也没取到，提取规则可能失效`);
    assert.deepEqual(got, want, `${rel} 的外发路径与 docs/privacy/egress-paths.json 不一致`);
  }
});

test("登记的数据类编号都在驻留面清单里；每个通道至少一类", () => {
  const ids = new Set(residency.rows.map((r) => r.id));
  for (const [rel, c] of Object.entries(registry.channels)) {
    assert.ok(c.classes.length > 0, rel);
    for (const id of c.classes) assert.ok(ids.has(id), `${rel}：数据类 ${id} 不在 residency.json`);
  }
});

test("闸门里所有写外发路径的源文件都在登记表里（新加一个通道文件不登记即失败）；提取规则对新加的路径敏感", () => {
  const files = ["cp-relay.ts", "dist-relay.ts", "notify-relay.ts", "share-relay.ts", "support-relay.ts", "server.ts"].map((f) => `packages/egress-gate/src/${f}`);
  for (const f of files) assert.ok(registry.channels[f], `${f} 没有登记`);
  // 反向对照：往源码里加一条路径，提取结果随之多一条
  const cp = read("packages/egress-gate/src/cp-relay.ts").replace("const PATHS: readonly RegExp[] = [", "const PATHS: readonly RegExp[] = [\n  /^\\/v1\\/new-thing$/,");
  assert.ok(outboundPaths("packages/egress-gate/src/cp-relay.ts", cp).includes("^\\/v1\\/new-thing$"));
  const nr = read("packages/egress-gate/src/notify-relay.ts").replace('path = "/v1/notify/due";', 'path = "/v1/notify/due";\n    path = `/v1/notify/extra/${x}`;');
  assert.ok(outboundPaths("packages/egress-gate/src/notify-relay.ts", nr).includes("/v1/notify/extra/{}"));
});

/** 登记表里的路径能否落到运营接口上（控制面白名单为正则，其余为模板，{} 按最坏情况取 "ops"）。 */
export function reachesOps(paths: string[], opsRe: RegExp): string[] {
  const samples = ["/v1/ops", "/v1/ops/tenants", "/v1/ops/tenants/ten_x", "/v1/ops/tenants/ten_x/activation-codes", "/v1/support/ops/packages", "/v1/support/ops/packages/SUP-AAAA-BBBB", "/v1/relay/ops/tenants/t1", "/v1/notify/ops/tenants/t1"];
  return paths.filter((p) => (p.startsWith("^") ? samples.some((s) => new RegExp(p).test(s)) : opsRe.test(p.replace(/\{\}/g, "ops"))));
}

test("律师电脑的闸门不外发到任何运营接口（v9.3 A-10：运营路径只给按人签名的运营，且只从运维网段进来）", async () => {
  const { OPS_PATH_RE } = await import("@zr-legal/ops-auth");
  const all = Object.values(registry.channels).flatMap((c) => c.paths);
  assert.deepEqual(reachesOps(all, OPS_PATH_RE), [], "闸门白名单或外发模板落到了运营路径上");
  // 反向对照：往控制面白名单里加一条运营路径、往模板里加一条运营路径，都能被认出
  assert.deepEqual(reachesOps(["^\\/v1\\/ops\\/tenants\\/[^/]+$"], OPS_PATH_RE), ["^\\/v1\\/ops\\/tenants\\/[^/]+$"]);
  assert.deepEqual(reachesOps(["/v1/relay/{}/tenants/x"], OPS_PATH_RE), ["/v1/relay/{}/tenants/x"]);
});
