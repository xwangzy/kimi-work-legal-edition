/**
 * 内核侧的工作区落盘加密（审计 S3 第 2 步；复核 S3B-A05/B-12、B-06、B-18）：
 * 成果登记按明文摘要、只认分块密文；升级后首跑不把“宿主刚迁移的存量明文”当作本次改动；取密钥失败不泄漏运行槽位。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveZoneKey, ZoneCodec } from "@zr-legal/at-rest";
import { diffWorkspace, snapshotWorkspace } from "../src/executor/workspace-artifacts.ts";
import { createKapAgentClient } from "../src/executor/kap-agent-client.ts";
import { Semaphore } from "../src/mutex.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

test("成果登记（加密工作区）：存量明文经宿主迁移后不算本次改动；新改动按明文登记；外部植入的明文、伪造的日志格式、他钥密文记 unreadable", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kwl-wsart-")));
  const codec = new ZoneCodec("work", new Map([[1, deriveZoneKey(randomBytes(32), "work")]]), 1);
  // 升级前：明文工作区
  writeFileSync(join(root, "旧草稿.md"), "旧草稿内容\n");
  writeFileSync(join(root, "将修改.md"), "第一版\n");
  const before = snapshotWorkspace(root, codec);
  // 宿主打开引擎时就地迁移（新 inode、大小与修改时间都变）
  const future = new Date(Date.now() + 5_000);
  for (const f of ["旧草稿.md", "将修改.md"]) {
    writeFileSync(join(root, f), codec.seal(readFileSync(join(root, f))));
    utimesSync(join(root, f), future, future);
  }
  // 本次运行：改了一个、新建一个；另有外部植入与伪造
  writeFileSync(join(root, "将修改.md"), codec.seal(Buffer.from("第二版\n")));
  writeFileSync(join(root, "新成果.md"), codec.seal(Buffer.from("新成果内容\n")));
  writeFileSync(join(root, "植入.md"), "外部写入的明文\n");
  writeFileSync(join(root, "空日志.md"), codec.newLog());
  const foreign = new ZoneCodec("work", new Map([[1, deriveZoneKey(randomBytes(32), "work")]]), 1);
  writeFileSync(join(root, "他钥.md"), foreign.seal(Buffer.from("别的事项")));
  const d = diffWorkspace(root, before, codec);
  const byPath = new Map(d.artifacts.map((a) => [a.path, a]));
  assert.equal(byPath.has("旧草稿.md"), false, "迁移而未改动的存量文件不登记为本次成果");
  assert.equal(byPath.get("将修改.md")?.bytes.toString(), "第二版\n");
  assert.equal(byPath.get("将修改.md")?.sha256, sha("第二版\n"));
  assert.equal(byPath.get("新成果.md")?.bytes.toString(), "新成果内容\n", "登记的是明文");
  assert.equal(byPath.get("新成果.md")?.status, "added");
  for (const f of ["植入.md", "空日志.md", "他钥.md"]) {
    assert.equal(byPath.has(f), false, f);
    assert.ok(d.skipped.some((s) => s.path === f && s.reason === "unreadable"), `${f} 记 unreadable`);
  }
});

test("取区密钥失败（解包失败、数据库错误）时运行槽位释放，后续运行不排队挂起（复核 S3B-B06）", { timeout: 20_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kwl-wsslot-")));
  mkdirSync(join(root, "m1", "work"), { recursive: true });
  const client = createKapAgentClient({
    entryPath: join(root, "不存在的宿主.ts"),
    dataRoot: root,
    kernelSocket: join(root, "k.sock"),
    trustedRgPath: null,
    manifests: () => [],
    legalMcpTools: [],
    matterPolicy: () => ({ dataLevel: "L2", basisComplete: true, fetchAllowlist: [], allowedPreauthorizations: [], budget: { maxToolCalls: 10, maxSubagents: 0 }, maxMode: "default", purpose: "legal_analysis" }),
    ioMutex: new Semaphore(1),
    atRest: {
      mode: "required",
      keys: () => {
        throw new Error("工作区密钥解包失败（模拟）");
      },
    },
  });
  const id = (rid: string) => ({ tid: "t", uid: "u", mid: "m1", rid, aid: "a", fence: 1 });
  for (const rid of ["r1", "r2", "r3"]) {
    const t0 = Date.now();
    await assert.rejects(client.start(id(rid), { goal: "x", materials: [] } as never), /解包失败/);
    assert.ok(Date.now() - t0 < 2_000, `第 ${rid} 次没有因槽位泄漏而排队`);
  }
  await client.close();
});
