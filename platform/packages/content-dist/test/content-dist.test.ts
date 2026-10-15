/**
 * 内容分发格式（第 8 批 S6/S7）：签名通道清单的核验、选包、分阶段分桶与方法模板包解析。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, createPrivateKey } from "node:crypto";
import {
  contentKeyId,
  inRollout,
  manifestShapeProblem,
  skillsVersionOf,
  parseSkillsPack,
  planInstall,
  signChannelManifest as signEnvelope,
  stagingBucket,
  verifyChannelManifest,
  type ChannelManifest,
} from "../src/index.ts";

function pair(): { pub: string; priv: string } {
  const k = generateKeyPairSync("ed25519");
  return { pub: k.publicKey.export({ type: "spki", format: "pem" }).toString(), priv: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}
/** 测试用签名回调（发布脚本里是 keys.signBytes）。 */
const signChannelManifest = (m: ChannelManifest, priv: string, pub: string) => signEnvelope(m, (b) => edSign(null, b, createPrivateKey(priv)).toString("base64url"), pub);
const K = pair();
const KEYS = new Map([[contentKeyId(K.pub), K.pub]]);
const SHA = "A".repeat(43);
const NOW = Date.parse("2026-10-15T08:00:00Z");

function lawdbManifest(over: Partial<ChannelManifest> = {}): ChannelManifest {
  return {
    schema: "kwl-dist/1",
    kind: "lawdb",
    channel: "stable",
    seq: 5,
    version: "g0.v3",
    content_sha256: SHA,
    issued_at: "2026-10-15T00:00:00.000Z",
    expires_at: "2026-11-14T00:00:00.000Z",
    staging_percent: 100,
    revoked_seqs: [],
    packages: [
      { type: "incremental", version: "g0.v2", base_version: "g0.v1", file: "i12.sqlite", size: 10, sha256: SHA, manifest_file: "i12.manifest.json", manifest_size: 5, manifest_sha256: SHA },
      { type: "incremental", version: "g0.v3", base_version: "g0.v2", file: "i23.sqlite", size: 10, sha256: SHA, manifest_file: "i23.manifest.json", manifest_size: 5, manifest_sha256: SHA },
      { type: "full", version: "g0.v3", file: "full.sqlite", size: 1000, sha256: SHA, manifest_file: "full.manifest.json", manifest_size: 5, manifest_sha256: SHA },
    ],
    ...over,
  };
}

test("通道清单：签名可核、改一个字段即失败、未知公钥与类别/通道不符拒绝、过期与未生效拒绝（随包信封可忽略有效期）", () => {
  const env = signChannelManifest(lawdbManifest(), K.priv, K.pub);
  assert.equal(env.kid, contentKeyId(K.pub));
  const ok = verifyChannelManifest(env, KEYS, { kind: "lawdb", channel: "stable", now: NOW });
  assert.ok(ok.ok && ok.manifest.seq === 5);
  const tampered = JSON.parse(JSON.stringify(env));
  tampered.manifest.seq = 6;
  assert.deepEqual(verifyChannelManifest(tampered, KEYS, { kind: "lawdb", now: NOW }), { ok: false, reason: "signature" });
  const other = pair();
  assert.deepEqual(verifyChannelManifest(signChannelManifest(lawdbManifest(), other.priv, other.pub), KEYS, { kind: "lawdb", now: NOW }), { ok: false, reason: "unknown_key" });
  // 用别的私钥签、却冒用信任表里的 kid
  const forged = { ...signChannelManifest(lawdbManifest(), other.priv, other.pub), kid: env.kid };
  assert.deepEqual(verifyChannelManifest(forged, KEYS, { kind: "lawdb", now: NOW }), { ok: false, reason: "signature" });
  assert.deepEqual(verifyChannelManifest(env, KEYS, { kind: "skills", now: NOW }), { ok: false, reason: "kind_mismatch" });
  assert.deepEqual(verifyChannelManifest(env, KEYS, { kind: "lawdb", channel: "beta", now: NOW }), { ok: false, reason: "channel_mismatch" });
  assert.deepEqual(verifyChannelManifest(env, KEYS, { kind: "lawdb", now: Date.parse("2026-11-14T00:00:00Z") }), { ok: false, reason: "expired" });
  assert.deepEqual(verifyChannelManifest(env, KEYS, { kind: "lawdb", now: Date.parse("2026-10-14T23:50:00Z") }), { ok: false, reason: "not_yet_valid" });
  assert.ok(verifyChannelManifest(env, KEYS, { kind: "lawdb", now: Date.parse("2027-06-01T00:00:00Z"), ignoreExpiry: true }).ok);
  // 信封多出字段、签名串不规范
  assert.deepEqual(verifyChannelManifest({ ...env, extra: 1 }, KEYS, { kind: "lawdb", now: NOW }), { ok: false, reason: "envelope" });
  assert.deepEqual(verifyChannelManifest({ ...env, sig: `${env.sig}=` }, KEYS, { kind: "lawdb", now: NOW }), { ok: false, reason: "signature" });
});

test("清单结构：文件名白名单（无路径、无 ..）、有效期 ≤ 90 天、撤回不含自身、全量只一个且版本等于清单版本、方法模板只有全量", () => {
  assert.equal(manifestShapeProblem(lawdbManifest()), null);
  const withPkg = (p: object) => lawdbManifest({ packages: [{ ...lawdbManifest().packages[2]!, ...p }] });
  assert.equal(manifestShapeProblem(withPkg({ file: "../x.sqlite" })), "package_file");
  assert.equal(manifestShapeProblem(withPkg({ file: "a/b.sqlite" })), "package_file");
  assert.equal(manifestShapeProblem(withPkg({ file: ".hidden" })), "package_file");
  assert.equal(manifestShapeProblem(withPkg({ file: "lawdb-1..2.sqlite" })), "package_file", "名字中间的 .. 也拒绝（与闸门一致，S8A-17）");
  assert.equal(manifestShapeProblem(withPkg({ manifest_file: "full.sqlite" })), "package_manifest");
  assert.equal(manifestShapeProblem(withPkg({ size: 0 })), "package_digest");
  assert.equal(manifestShapeProblem(withPkg({ size: 65 * 1024 * 1024 })), "package_digest");
  assert.equal(manifestShapeProblem(withPkg({ version: "g0.other" })), "package_full");
  assert.equal(manifestShapeProblem(withPkg({ extra: true })), "package_fields");
  assert.equal(manifestShapeProblem(lawdbManifest({ expires_at: "2027-02-01T00:00:00.000Z" })), "time");
  assert.equal(manifestShapeProblem(lawdbManifest({ revoked_seqs: [5] })), "revoked");
  assert.equal(manifestShapeProblem(lawdbManifest({ staging_percent: 101 })), "staging");
  assert.equal(manifestShapeProblem(lawdbManifest({ seq: 0 })), "seq");
  const dup = lawdbManifest();
  dup.packages[1] = { ...dup.packages[1]!, file: "i12.sqlite" };
  assert.equal(manifestShapeProblem(dup), "package_file_dup");
  const skills = lawdbManifest({ kind: "skills", packages: [{ type: "full", version: "g0.v3", file: "s.json", size: 3, sha256: SHA }] });
  assert.equal(manifestShapeProblem(skills), null);
  assert.equal(manifestShapeProblem({ ...skills, packages: [{ type: "incremental", version: "g0.v3", base_version: "a", file: "s.json", size: 3, sha256: SHA }] }), "package_type");
});

test("选包：能沿增量链到达就走增量（多步），断链或未知版本走全量，已是最新返回 null", () => {
  const m = lawdbManifest();
  assert.deepEqual(planInstall(m, "g0.v1")?.packages.map((p) => p.file), ["i12.sqlite", "i23.sqlite"]);
  assert.deepEqual(planInstall(m, "g0.v2")?.packages.map((p) => p.file), ["i23.sqlite"]);
  assert.equal(planInstall(m, "g0.zz")?.type, "full");
  assert.equal(planInstall(m, null)?.type, "full");
  assert.equal(planInstall(m, "g0.v3"), null);
  const noFull = lawdbManifest({ packages: lawdbManifest().packages.slice(0, 1) });
  assert.equal(planInstall(noFull, "g0.v2"), null, "增量链到不了、又没有全量");
  // 链比全量重：走全量（S8A-11）
  const heavy = lawdbManifest();
  heavy.packages[2] = { ...heavy.packages[2]!, size: 20 };
  assert.equal(planInstall(heavy, "g0.v1")?.type, "full");
  // 同一 base_version 有两个增量：第一个走进死胡同时仍能找到通路（广度优先，S8A-20）
  const branch = lawdbManifest();
  branch.packages.unshift({ type: "incremental", version: "g0.dead", base_version: "g0.v1", file: "dead.sqlite", size: 10, sha256: SHA, manifest_file: "dead.manifest.json", manifest_size: 5, manifest_sha256: SHA });
  assert.deepEqual(planInstall(branch, "g0.v1")?.packages.map((p) => p.file), ["i12.sqlite", "i23.sqlite"]);
});

test("方法模板版本标签：发布脚本与内核同一推导，摘要以 - 或 _ 开头也合规（S8A-09）", () => {
  for (const sha of ["_abcDEF-ghi_jkl-mnopqrstuvwxyz0123456789ABC", "-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]) {
    const v = skillsVersionOf(sha);
    assert.match(v, /^[A-Za-z0-9]{1,16}$/);
    assert.equal(manifestShapeProblem({ ...lawdbManifest({ kind: "skills", version: v, packages: [{ type: "full", version: v, file: "s.json", size: 3, sha256: SHA }] }) }), null);
  }
});

test("分阶段推送：同一设备对同一 seq 结论稳定；0% 无人、100% 全部；约按比例", () => {
  assert.equal(stagingBucket("dev_a", 7), stagingBucket("dev_a", 7));
  assert.ok(!inRollout({ staging_percent: 0, seq: 7 }, "dev_a"));
  assert.ok(inRollout({ staging_percent: 100, seq: 7 }, "dev_a"));
  let n = 0;
  for (let i = 0; i < 2000; i++) if (inRollout({ staging_percent: 25, seq: 3 }, `dev_${i}`)) n++;
  assert.ok(n > 400 && n < 600, `25% 灰度命中 ${n}/2000`);
});

test("方法模板包解析：路径越界、绝对路径、重复（大小写不敏感）、多余字段一律拒绝", () => {
  const pack = (files: unknown[], extra: object = {}) => new TextEncoder().encode(JSON.stringify({ schema: "kwl-skills-pack/1", manifest: "{}", files, ...extra }));
  assert.ok(parseSkillsPack(pack([{ path: "skills/a/SKILL.md", data: "" }, { path: "AGENTS.md", data: "" }])).ok);
  for (const bad of ["../x", "skills/../../x", "/etc/x", "a//b", "a/", "./a", "a/./b", "C:\\x", "a\\b"]) {
    assert.deepEqual(parseSkillsPack(pack([{ path: bad, data: "" }])), { ok: false, reason: "pack_path" }, bad);
  }
  assert.deepEqual(parseSkillsPack(pack([{ path: "A.md", data: "" }, { path: "a.md", data: "" }])), { ok: false, reason: "pack_dup" });
  assert.deepEqual(parseSkillsPack(pack([], { more: 1 })), { ok: false, reason: "pack_shape" });
  assert.deepEqual(parseSkillsPack(new TextEncoder().encode("not json")), { ok: false, reason: "pack_json" });
});
