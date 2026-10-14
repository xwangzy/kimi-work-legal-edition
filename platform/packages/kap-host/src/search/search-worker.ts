/**
 * 宿主内检索 worker（审计 S3 第 2 步；复核 S3B-B02/B03）：在独立线程里按区描述重建只读文件 broker（区密钥解码为区编解码器），
 * 经 broker 遍历与解封执行检索，输出按约 64 KiB 一批送回宿主主线程。宿主 kill 即 terminate 本线程（硬终止）；
 * 堆上限由宿主的 resourceLimits 约束，超限只终止本线程。结束时清零区密钥。
 */
import { parentPort, workerData } from "node:worker_threads";
import { ZoneCodec } from "@zr-legal/at-rest";
import { FileBroker, type ZoneSpec } from "@zr-legal/file-broker";
import { runSearch } from "./engine.ts";
import { brokerSearchFs, type SearchZoneSpec } from "./host-search.ts";

const { args, cwd, pathClass, zones } = workerData as { args: string[]; cwd: string; pathClass: "posix" | "win32"; zones: SearchZoneSpec[] };

const FLUSH = 64 * 1024;
let out = "";
let err = "";
const flush = () => {
  if (out) parentPort?.postMessage({ t: "out", s: out });
  if (err) parentPort?.postMessage({ t: "err", s: err });
  out = "";
  err = "";
};

const codecs: ZoneCodec[] = [];
async function main(): Promise<number> {
  const specs: ZoneSpec[] = zones.map((z) => {
    const codec = z.keys ? ZoneCodec.fromWire(z.keys) : null;
    if (codec) codecs.push(codec);
    return { name: z.name, root: z.root, access: "ro", ...(codec ? { codec } : {}), ...(z.strict ? { strict: true } : {}), ...(z.chunkedOnly ? { chunkedOnly: true } : {}) };
  });
  const broker = new FileBroker(specs);
  return runSearch(args, {
    cwd,
    pathClass,
    fs: brokerSearchFs(broker, new Set(zones.map((z) => z.name)), pathClass),
    io: {
      out: (s) => {
        out += s;
        if (out.length >= FLUSH) flush();
      },
      err: (s) => {
        err += s;
        if (err.length >= FLUSH) flush();
      },
      aborted: () => false,
    },
  });
}

main()
  .then(
    (code) => code,
    (e: unknown) => {
      err += `rg: ${(e as Error)?.message ?? e}\n`;
      return 2;
    },
  )
  .then((code) => {
    for (const c of codecs) c.wipe();
    flush();
    parentPort?.postMessage({ t: "exit", code });
  });
