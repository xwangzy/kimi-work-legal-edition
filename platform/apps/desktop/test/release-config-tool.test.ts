/**
 * make-release-config（客户端 release.json 生成工具）：第 46 批从 services/control-plane/test/ops-console.test.ts 挪来——
 * 这个工具用桌面端的 electron/release-config.cjs 做最终校验，属于客户端；独立云端仓库只交付它需要的材料（地址、备份公钥、公钥表）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "kwl-release-tool-"));
const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

test("make-release-config：备份钉住、公钥表填好并过客户端校验；少于两把钉住或缺公钥表即不写文件", () => {
  const out = join(dir, "init");
  const g = spawnSync(process.execPath, [join(root, "scripts/cloud-init-secrets.mjs"), "--env", "test", "--out", out, "--id", "t1", "--mount", join(out, "secrets")], { encoding: "utf8" });
  assert.equal(g.status, 0, g.stderr);
  const backup = (n: string) => {
    const p = join(dir, `${n}.pub.pem`);
    writeFileSync(p, String(generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" })));
    return p;
  };
  const cur = { control_plane: [backup("cp")], gateway: [backup("gw")], search: [backup("se")] };
  const spec = {
    control_plane_base: "https://cp.kwl.example.com",
    gateway_base: "https://gw.kwl.example.com/v1",
    search_base: "https://search.kwl.example.com/v1/search",
    pins: cur,
    backup_pins: [backup("bk")],
    cp_public_keys_file: join(out, "public/cp-public-keys.json"),
    seat_public_keys_file: join(out, "public/seat-public-keys.json"),
    test_build: true,
  };
  const target = join(dir, "release.json");
  const run = (s: unknown) => spawnSync(process.execPath, [join(root, "scripts/make-release-config.mjs"), "--offline", "--spec", write(`spec-${Math.random()}.json`, JSON.stringify(s)), "--out", target], { encoding: "utf8" });
  const r = run(spec);
  assert.equal(r.status, 0, r.stderr);
  const rel = JSON.parse(readFileSync(target, "utf8"));
  assert.equal(rel.gateway_pins.length, 2);
  assert.match(rel.gateway_pins[0], /^sha256\/[A-Za-z0-9+/]{43}=$/);
  assert.deepEqual(Object.keys(rel.control_plane_keys), ["cp-test-t1", "cp-test-t2"]);
  assert.equal(rel.test_build, true);
  assert.match(run({ ...spec, backup_pins: [] }).stderr, /至少要当前 \+ 备份两把/);
  assert.match(run({ ...spec, seat_public_keys_file: undefined }).stderr, /seat_public_keys_file/);
  assert.match(run({ ...spec, pins: { ...cur, gateway: [join(out, "secrets/seat.pem")] } }).stderr, /是私钥/);
});

