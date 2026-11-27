// 300 ms 路径 B 卡住的取证会话（cfg.diag）：每个版本 1 次；卡在过渡页 15 s 后读 kernel.status、再手动整页重载一次。
// 账号链接着正式 300 ms 组：乙 = 序号 45（彭测时，正式组最后一轮的甲，已退出登录）
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const SP = "/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/0d6e0c1f-ceda-4025-9dcf-13a576f15bc5/scratchpad";
const NAMES = "赵钱孙李周吴郑冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤".split("");
const phone = (i) => `1390007${230 + i}0`;
const name = (i) => `${NAMES[i]}测时`;
for (const [k, ver] of [[0, "b71"], [1, "b72"]]) {
  const a = 46 + k, b = 45 + k;
  const cfg = { tag: `diag-${ver}-300`, ver, lat: 300, diag: true, wt: ver === "b71" ? "kimi-legal-b71" : "kimi-legal-b72", webPort: ver === "b71" ? 5751 : 5761, ud: join(SP, "et/ud5", `diag-${ver}-300`), out: join(here, "raw/results-diag.jsonl"), phoneA: phone(a), nameA: name(a), phoneB: phone(b), nameB: name(b) };
  console.log(`\n===== ${cfg.tag} A=${cfg.phoneA} B=${cfg.phoneB} =====`);
  spawnSync(process.execPath, [join(here, "session.mjs"), JSON.stringify(cfg)], { stdio: "inherit", timeout: 600000 });
}
