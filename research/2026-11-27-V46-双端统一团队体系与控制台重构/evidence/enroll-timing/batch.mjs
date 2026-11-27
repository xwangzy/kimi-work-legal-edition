// 顺序跑一组会话：node batch.mjs <起始序号> <结束序号（含）>；会话表见 plan()
// 账号链：会话 s 的“账号乙”= 会话 s-1 注册的账号（它在会话 s-1 的路径 B 里已退出登录，不占同时登录名额）
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const SP = "/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/0d6e0c1f-ceda-4025-9dcf-13a576f15bc5/scratchpad";
const NAMES = "赵钱孙李周吴郑冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤".split("");
const phone = (i) => `1390007${230 + i}0`;
const name = (i) => `${NAMES[i]}测时`;
// 试跑（raw/pilot/）用掉手机号序号 0～8 且两个批次曾意外并发，账号登录状态不可知：正式轮从序号 20 起另起一条账号链，
// 先跑一个只注册并退出登录的种子会话（不计入统计），为第一轮供乙
const OFFSET = 20;
export let plan = function () {
  const s = [{ tag: "seed", ver: "b71", lat: 0, logoutOnly: true }];
  for (const lat of [0, 300]) for (const r of [1, 2, 3]) for (const ver of ["b71", "b72"]) s.push({ tag: `${ver}-${lat}-r${r}`, ver, lat });
  return s.map((x, i) => ({ ...x, i, phoneA: phone(OFFSET + i), nameA: name(OFFSET + i), ...(i > 0 ? { phoneB: phone(OFFSET + i - 1), nameB: name(OFFSET + i - 1) } : {}) }));
};
// 300 ms 组第一次全部卡在“获取验证码过于频繁”（云端每个来源地址每小时 20 条短信，按 UTC 整点分桶；试跑与 0 ms 组已用满）：
// 整点后重跑，改用序号 40 起的新手机号，第一轮的乙 = 0 ms 组最后一轮的甲（序号 26，已退出登录）
if (process.env.RERUN300 === "1") {
  const all = plan();
  plan = () => all.map((x) => {
    if (x.lat !== 300) return x;
    const k = x.i - 7;
    const a = 40 + k, b = k === 0 ? 26 : 40 + k - 1;
    return { ...x, tag: `${x.tag}`, phoneA: phone(a), nameA: name(a), phoneB: phone(b), nameB: name(b) };
  });
}
const [from, to] = process.argv.slice(2).map(Number);
if (Number.isFinite(from)) {
  for (const x of plan().slice(from, to + 1)) {
    const cfg = { ...x, wt: x.ver === "b71" ? "kimi-legal-b71" : "kimi-legal-b72", webPort: x.ver === "b71" ? 5751 : 5761, ud: join(SP, process.env.RERUN300 === "1" && x.lat === 300 ? "et/ud4" : "et/ud3", x.tag), out: join(here, "results.jsonl"), shot: x.i >= 1 && x.i <= 2 };
    console.log(`\n===== #${x.i} ${x.tag} A=${x.phoneA} B=${x.phoneB ?? "-"} =====`);
    spawnSync(process.execPath, [join(here, "session.mjs"), JSON.stringify(cfg)], { stdio: "inherit", timeout: 600000 });
  }
}
