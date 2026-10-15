/**
 * 随包运行时（安装包形态，收敛偏离 D-05/D-23）：scripts/build-runtime.mjs 产出的目录能独立承载 W 执行域。
 *
 * 覆盖：清单核验（存在性、摘要、路径不出目录）；W 只被授权读取随包运行时目录，仍通过权限自检；
 * 从随包目录装载 just-bash（摘要与补丁锚点校验）并执行 bash 与 python3；运行时不完整即不可用（不回落开发路径）。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileBroker } from "@zr-legal/file-broker";
import { WCoreDomain, type WProcess } from "../src/domain.ts";
import { selftestProblems, WUnavailableError, WSupervisor } from "../src/host.ts";

const require = createRequire(import.meta.url);
const { resolveBundledRuntime, verifyRuntimeDigests } = require("../../../apps/desktop/electron/runtime-paths.cjs") as {
  resolveBundledRuntime: (root: string, o?: { verifyDigests?: boolean; trustedManifestFile?: string; unpackedRoot?: string }) => { ok: true; env: Record<string, string>; manifest: any } | { ok: false; problems: string[] };
  verifyRuntimeDigests: (root: string, manifest: any) => Promise<string[]>;
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
    for (const k of ["KWL_AGENT_HOST_NODE", "KWL_GATE_NODE", "KWL_W_RUNTIME_DIR", "ZR_KAP_HOST_ENTRY", "ZR_EGRESS_GATE_ENTRY", "KWL_PARSE_NODE", "KWL_PARSE_WORKER_ENTRY", "ZR_OCR_MODEL_DIR"]) {
      assert.ok(r.env[k]!.startsWith(rt), `${k} 应在运行时目录内：${r.env[k]}`);
    }
    assert.match(r.env.KWL_RUNTIME_NODE_VERSION!, /^v26\./);
    assert.equal(r.env.KWL_RUNTIME_NODE_SHA256, r.manifest.files.node.sha256);
    // Y5 P1-5：闸门、宿主与解析进程各用独立文件名的随包 Node（与 node 同字节同摘要），WER 排除与防火墙规则按程序名
    const base = (p: string) => p.split(/[\\/]/).pop()!.replace(/\.exe$/, "");
    assert.equal(base(r.env.KWL_GATE_NODE!), "kwl-egress");
    assert.equal(base(r.env.KWL_AGENT_HOST_NODE!), "kwl-host");
    assert.equal(base(r.env.KWL_PARSE_NODE!), "kwl-parse");
    for (const k of ["nodeEgress", "nodeHost", "nodeParse"]) assert.equal(r.manifest.files[k].sha256, r.manifest.files.node.sha256, k);
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

  test("随包解析进程（W6）：随包 Node 从运行时目录装载 pdfjs/pdfium/canvas/onnxruntime 与 OCR 模型，不依赖仓库 node_modules", { timeout: 180_000 }, async () => {
    const { runParseBatch, testingPdf } = await import("@zr-legal/parse-ocr");
    const r = resolveBundledRuntime(rt);
    assert.ok(r.ok);
    if (!r.ok) return;
    for (const k of ["KWL_PARSE_NODE", "KWL_PARSE_WORKER_ENTRY", "ZR_OCR_MODEL_DIR"]) assert.ok(r.env[k]!.startsWith(rt), `${k} 应在运行时目录内：${r.env[k]}`);
    // 运行时在系统临时目录（仓库之外）：模块解析无法回落到仓库的 node_modules，依赖闭包缺一项即失败
    const worker = { execPath: r.env.KWL_PARSE_NODE!, workerEntry: r.env.KWL_PARSE_WORKER_ENTRY! };
    const text = await runParseBatch({ file: testingPdf.makeTextPdf(["Signed on 2024-03-15 by both parties"]), kind: "pdf", ...worker });
    assert.equal(text.pages.length, 1);
    assert.match(text.pages[0]!.text, /2024-03-15/);
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(720, 160);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 720, 160);
    ctx.fillStyle = "#000000";
    ctx.font = "64px sans-serif";
    ctx.fillText("INVOICE 2024", 40, 105);
    const dir = r.env.ZR_OCR_MODEL_DIR!;
    const modelPaths = { det: join(dir, "ch_PP-OCRv5_det_mobile.onnx"), rec: join(dir, "ch_PP-OCRv5_rec_mobile.onnx"), dict: join(dir, "ppocrv5_dict.txt") };
    const img = await runParseBatch({ file: canvas.toBuffer("image/png"), kind: "image", modelPaths, ...worker });
    assert.equal(img.pages.length, 1);
    assert.equal(img.pages[0]!.kind, "image");
    assert.match(img.pages[0]!.text.replace(/\s+/g, ""), /2024/, `OCR 结果：${img.pages[0]!.text}（${img.pages[0]!.note ?? ""}）`);
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
    // 安装包形态以 asar 内的清单副本为准：攻击者把被改文件的新摘要写进盘上清单也不能放行
    const bad2 = join(base, "bad2");
    cpSync(rt, bad2, { recursive: true });
    const trusted = join(base, "trusted-manifest.json");
    cpSync(join(rt, "runtime-manifest.json"), trusted);
    writeFileSync(join(bad2, "egress-gate", "main.mjs"), "// 被替换的闸门\n");
    const forged = JSON.parse(readFileSync(join(bad2, "runtime-manifest.json"), "utf8"));
    forged.files.gate.sha256 = createHash("sha256").update("// 被替换的闸门\n").digest("hex");
    writeFileSync(join(bad2, "runtime-manifest.json"), JSON.stringify(forged));
    assert.equal(resolveBundledRuntime(bad2).ok, true, "对照：只看盘上清单会被骗过");
    const r3 = resolveBundledRuntime(bad2, { trustedManifestFile: trusted });
    assert.ok(!r3.ok && r3.problems.some((p) => p.includes("egress-gate/main.mjs")), "按 asar 内清单应判摘要不符");
    // W 运行时缺 worker：构造即不可用
    rmSync(join(bad, "w", "worker.mjs"));
    assert.throws(() => new WSupervisor({ dataDirs: [], tmpDir: join(base, "t"), runtimeDir: join(bad, "w") }), WUnavailableError);
  });
  test("全部文件纳入核验（复核 B4-A01）：依赖闭包里的文件被改（同样大小）由后台摘要比对发现；清单外多出文件、清单项缺摘要、asar.unpacked 原生模块被改都判损坏", async () => {
    const trusted = join(base, "trusted-all.json");
    cpSync(join(rt, "runtime-manifest.json"), trusted);
    const m = JSON.parse(readFileSync(trusted, "utf8"));
    assert.ok(Array.isArray(m.all) && m.all.length > 100, "清单应列出全部文件");
    assert.ok(m.all.some((e: any) => e.path.startsWith("parse/node_modules/")), "依赖闭包在清单内");
    // 干净的运行时：同步与后台核验都通过
    const clean = resolveBundledRuntime(rt, { trustedManifestFile: trusted });
    assert.equal(clean.ok, true, clean.ok ? "" : clean.problems.join("；"));
    assert.deepEqual(await verifyRuntimeDigests(rt, m), []);
    // 依赖闭包里的一个 JS 被改（同样大小）：启动时的存在与大小核对放行，后台摘要比对发现
    const dep = join(base, "dep");
    cpSync(rt, dep, { recursive: true });
    const victim = m.all.find((e: any) => e.path.startsWith("parse/node_modules/") && e.path.endsWith(".js") && e.size > 16);
    const vp = join(dep, victim.path);
    const buf = readFileSync(vp);
    buf[0] = buf[0] === 0x20 ? 0x0a : 0x20;
    writeFileSync(vp, buf);
    assert.equal(resolveBundledRuntime(dep, { trustedManifestFile: trusted }).ok, true, "大小未变：同步核对放行");
    const late = await verifyRuntimeDigests(dep, m);
    assert.ok(late.some((p) => p.includes(victim.path)), `后台摘要比对应发现：${late.join("；")}`);
    // 清单外多出文件
    writeFileSync(join(dep, "parse", "node_modules", "injected.js"), "module.exports = 1;\n");
    const r1 = resolveBundledRuntime(dep, { trustedManifestFile: trusted });
    assert.ok(!r1.ok && r1.problems.some((p) => p.includes("清单外的文件")), "清单外文件应判损坏");
    // 清单项缺摘要（安装包形态不得跳过比对）
    const noSha = join(base, "trusted-nosha.json");
    const m2 = JSON.parse(readFileSync(trusted, "utf8"));
    delete m2.files.gate.sha256;
    writeFileSync(noSha, JSON.stringify(m2));
    const r2 = resolveBundledRuntime(rt, { trustedManifestFile: noSha });
    assert.ok(!r2.ok && r2.problems.some((p) => p.includes("缺少摘要")));
    // asar.unpacked 原生模块
    const unpacked = join(base, "unpacked");
    mkdirSync(join(unpacked, "node_modules", "x", "prebuilds"), { recursive: true });
    writeFileSync(join(unpacked, "node_modules", "x", "prebuilds", "a.node"), "native");
    const m3 = JSON.parse(readFileSync(trusted, "utf8"));
    m3.unpacked = [{ path: "node_modules/x/prebuilds/a.node", sha256: createHash("sha256").update("native").digest("hex") }];
    const withUnpacked = join(base, "trusted-unpacked.json");
    writeFileSync(withUnpacked, JSON.stringify(m3));
    assert.equal(resolveBundledRuntime(rt, { trustedManifestFile: withUnpacked, unpackedRoot: unpacked }).ok, true);
    writeFileSync(join(unpacked, "node_modules", "x", "prebuilds", "a.node"), "nativf");
    const r3 = resolveBundledRuntime(rt, { trustedManifestFile: withUnpacked, unpackedRoot: unpacked });
    assert.ok(!r3.ok && r3.problems.some((p) => p.includes("a.node")));
  });
});
