/**
 * 随包运行时（安装包形态，收敛偏离 D-05/D-23）：scripts/build-runtime.mjs 产出的目录能独立承载 W 执行域。
 *
 * 覆盖：清单核验（存在性、摘要、路径不出目录）；W 只被授权读取随包运行时目录，仍通过权限自检；
 * 从随包目录装载 just-bash（摘要与补丁锚点校验）并执行 bash 与 python3；运行时不完整即不可用（不回落开发路径）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileBroker } from "@zr-legal/file-broker";
import { WCoreDomain, type WProcess } from "../src/domain.ts";
import { selftestProblems, WUnavailableError, WSupervisor } from "../src/host.ts";

const require = createRequire(import.meta.url);
const { resolveBundledRuntime } = require("../../../apps/desktop/electron/runtime-paths.cjs") as {
  resolveBundledRuntime: (root: string, o?: { verifyDigests?: boolean }) => { ok: true; env: Record<string, string>; manifest: any } | { ok: false; problems: string[] };
};
const platformRoot = fileURLToPath(new URL("../../../", import.meta.url));

async function collect(p: WProcess): Promise<{ code: number; out: string }> {
  let out = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (c: string) => (out += c));
  const ended = new Promise((r) => p.stdout.on("end", r));
  const code = await p.wait();
  await ended;
  return { code, out };
}

describe("随包运行时（scripts/build-runtime.mjs）", () => {
  let base: string;
  let rt: string;
  before(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "kwl-rt-")));
    rt = join(base, "runtime");
    execFileSync(process.execPath, [join(platformRoot, "scripts/build-runtime.mjs"), "--out", rt], { env: { ...process.env }, stdio: "pipe" });
  });
  after(() => rmSync(base, { recursive: true, force: true }));

  test("清单核验通过，环境变量全部指向运行时目录之内", () => {
    const r = resolveBundledRuntime(rt);
    assert.equal(r.ok, true, r.ok ? "" : r.problems.join("；"));
    if (!r.ok) return;
    for (const k of ["KWL_AGENT_HOST_NODE", "KWL_GATE_NODE", "KWL_W_RUNTIME_DIR", "ZR_KAP_HOST_ENTRY", "ZR_EGRESS_GATE_ENTRY"]) {
      assert.ok(r.env[k]!.startsWith(rt), `${k} 应在运行时目录内：${r.env[k]}`);
    }
    assert.match(r.env.KWL_RUNTIME_NODE_VERSION!, /^v26\./);
    assert.equal(r.env.KWL_RUNTIME_NODE_SHA256, r.manifest.files.node.sha256);
  });

  test("W 只读随包目录也能通过自检，并执行 bash 与 python3", async () => {
    const r = resolveBundledRuntime(rt);
    assert.ok(r.ok);
    if (!r.ok) return;
    const work = join(base, "m", "work");
    const materials = join(base, "m", "materials");
    mkdirSync(work, { recursive: true });
    mkdirSync(materials, { recursive: true });
    writeFileSync(join(materials, "合同.txt"), "借款金额：人民币 100,000 元\n");
    const broker = new FileBroker([
      { name: "materials", root: materials, access: "ro" },
      { name: "work", root: work, access: "rw" },
    ]);
    const domain = await WCoreDomain.start({
      broker,
      work: { zone: "work", root: work },
      readOnlyRoots: [materials],
      pathClass: "posix",
      tmpDir: join(base, "w-tmp"),
      supervisor: {
        maxConcurrent: 1,
        nodePath: r.env.KWL_AGENT_HOST_NODE!,
        nodeSha256: r.env.KWL_RUNTIME_NODE_SHA256!,
        expectedNodeVersion: r.env.KWL_RUNTIME_NODE_VERSION!,
        runtimeDir: r.env.KWL_W_RUNTIME_DIR!,
      },
    });
    try {
      assert.deepEqual(selftestProblems(await domain.supervisor.selftest(), r.env.KWL_RUNTIME_NODE_VERSION!), []);
      const a = await collect(await domain.run(`cd '${work}' && grep -c 人民币 '${materials}/合同.txt' && echo 完成 > 结果.txt`, { cwd: work }));
      assert.equal(a.code, 0);
      assert.equal(a.out.trim(), "1");
      assert.equal(readFileSync(join(work, "结果.txt"), "utf8").trim(), "完成");
      const b = await collect(await domain.run(`cd '${work}' && python3 -c "print(sum([1,2,3]))"`, { cwd: work }));
      assert.equal(b.code, 0);
      assert.equal(b.out.trim(), "6");
    } finally {
      await domain.close();
    }
  });

  test("随包的宿主内检索 worker（kap-host/search-worker.mjs）能在加密区上独立运行：经只读 broker 解封检索（审计 S3 第 2 步）", async () => {
    const { Worker } = await import("node:worker_threads");
    const { randomBytes } = await import("node:crypto");
    const { deriveZoneKey, ZoneCodec } = await import("@zr-legal/at-rest");
    const r = resolveBundledRuntime(rt);
    assert.ok(r.ok);
    const zoneRoot = join(base, "search", "work");
    mkdirSync(zoneRoot, { recursive: true });
    const codec = new ZoneCodec("work", new Map([[1, deriveZoneKey(randomBytes(32), "work")]]), 1);
    writeFileSync(join(zoneRoot, "合同.txt"), codec.seal(Buffer.from("违约金为合同总价的百分之二十\n")));
    const w = new Worker(join(rt, "kap-host", "search-worker.mjs"), {
      workerData: { args: ["--null", "-n", "--with-filename", "--", "百分之\\p{Han}+", zoneRoot], cwd: zoneRoot, pathClass: "posix", zones: [{ name: "work", root: zoneRoot, strict: true, chunkedOnly: true, keys: codec.toWire() }] },
    });
    let out = "";
    const code = await new Promise<number>((resolve, reject) => {
      w.on("message", (m: { t: string; s?: string; code?: number }) => {
        if (m.t === "out") out += m.s;
        if (m.t === "exit") resolve(m.code ?? -1);
      });
      w.on("error", reject);
    });
    await w.terminate();
    assert.equal(code, 0);
    assert.equal(out, `${join(zoneRoot, "合同.txt")}\u00001:违约金为合同总价的百分之二十\n`);
  });

  test("文件被改动或缺失即判运行时损坏；W 不回落到开发路径", () => {
    const bad = join(base, "bad");
    cpSync(rt, bad, { recursive: true });
    writeFileSync(join(bad, "kap-host", "main.mjs"), "// 被改动\n");
    const r1 = resolveBundledRuntime(bad);
    assert.equal(r1.ok, false);
    assert.ok(!r1.ok && r1.problems.some((p) => p.includes("摘要不符")));
    // 清单把路径指向目录之外：拒绝
    const m = JSON.parse(readFileSync(join(bad, "runtime-manifest.json"), "utf8"));
    m.files.node.path = "../../outside/node";
    writeFileSync(join(bad, "runtime-manifest.json"), JSON.stringify(m));
    const r2 = resolveBundledRuntime(bad, { verifyDigests: false });
    assert.ok(!r2.ok && r2.problems.some((p) => p.includes("node")));
    // W 运行时缺 worker：构造即不可用
    rmSync(join(bad, "w", "worker.mjs"));
    assert.throws(() => new WSupervisor({ dataDirs: [], tmpDir: join(base, "t"), runtimeDir: join(bad, "w") }), WUnavailableError);
  });
});
