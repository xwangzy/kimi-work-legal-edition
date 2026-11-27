// 生产渲染形态（ZR_DESKTOP_PROD=1 + vite build 产物）复测：node prodbatch.mjs <延迟 300|0>
// 账号链接着取证会话：第一轮的乙 = 序号 47（diag-b72-300 的甲，已退出登录）；300 ms 组用序号 50～55，0 ms 组用序号 56～61
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const SP = "/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/0d6e0c1f-ceda-4025-9dcf-13a576f15bc5/scratchpad";
const NAMES = "赵钱孙李周吴郑冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤".split("");
const phone = (i) => `1390007${230 + i}0`;
const name = (i) => `${NAMES[i]}测时`;
const lat = Number(process.argv[2]);
const base = lat === 300 ? 50 : 56;
let prevB = lat === 300 ? 47 : 55;
let k = 0;
// 0 ms 组在 r2·改后起撞上短信限流（每来源地址每小时 20 条），这三轮在 UTC 下一个整点后补跑：RESUME0=1 只跑这三轮，
// 手机号用序号 62～64，第一轮的乙 = 序号 58（prod-b71-0-r2 的甲，已退出登录）
const resume = process.env.RESUME0 === "1" && lat === 0;
if (resume) prevB = 58;
const todo = resume ? [[2, "b72"], [3, "b71"], [3, "b72"]] : [1, 2, 3].flatMap((r) => ["b71", "b72"].map((v) => [r, v]));
for (const [r, ver] of todo) {
  const a = resume ? 62 + k++ : base + k++;
  const tag = `prod-${ver}-${lat}-r${r}`;
  const cfg = { tag, ver, lat, prod: true, wt: ver === "b71" ? "kimi-legal-b71" : "kimi-legal-b72", webPort: ver === "b71" ? 5751 : 5761, ud: join(SP, "et/ud6", tag), out: join(here, "results-prod.jsonl"), phoneA: phone(a), nameA: name(a), phoneB: phone(prevB), nameB: name(prevB), shot: r === 1 };
  console.log(`\n===== ${tag} A=${cfg.phoneA} B=${cfg.phoneB} =====`);
  spawnSync(process.execPath, [join(here, "session.mjs"), JSON.stringify(cfg)], { stdio: "inherit", timeout: 600000 });
  prevB = a;
}
