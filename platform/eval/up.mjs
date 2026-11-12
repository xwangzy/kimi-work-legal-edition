// 按 stacks.json 后台起测试栈；日志在 <工作目录>/stack-<栈名>/stack.log。用法：node eval/up.mjs <栈名> [<栈名>…]
// 停：node eval/up.mjs --stop <栈名>…（按端口找进程；杀外层进程不会连带停掉界面与内核）
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { EVAL, stackDir, stackOf, syncMaterials } from "./lib.mjs";

const args = process.argv.slice(2);
if (args[0] === "--stop") {
  for (const name of args.slice(1)) {
    const w = stackOf(name);
    for (const port of [w.web, w.bridge, w.gw, w.search]) {
      let pids = [];
      try {
        pids = execFileSync("/usr/sbin/lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean);
      } catch {}
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {}
      }
      console.log(name, port, pids.length ? `已停 ${pids.join(" ")}` : "没有进程");
    }
  }
} else {
  syncMaterials();
  for (const name of args) {
    const w = stackOf(name);
    mkdirSync(stackDir(w), { recursive: true });
    const out = openSync(join(stackDir(w), "up.out"), "a");
    const k = spawn(process.execPath, [join(EVAL, "stack.mjs"), name], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, KWL_EVAL_SYNCED: "1" } });
    k.unref();
    // 依次起：内核开发桥启动时会重建并签名工具清单等产物，两套同时起会互相覆盖（其中一套的内核直接退出）。等这一套的开发桥能连上再起下一套
    let up = false;
    for (let i = 0; i < 90 && !up; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      up = await fetch(`http://127.0.0.1:${w.bridge}/`).then(() => true, () => false);
    }
    console.log(name, "pid", k.pid, up ? "已就绪" : "90 秒内开发桥没有起来，看 stack.log");
  }
}
