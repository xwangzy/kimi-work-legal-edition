// 修复后复测与故障注入（b72，2f90cb4f 之后的 HEAD）：node rerun-b72.mjs [起始序号]
// 手机号 13900072601 起（跳过末位 0，与前几节的号段不重）；第一轮的乙 = 13900072880（prod-b71-0-r2 的甲，已退出登录）
// 撞上短信限流（每来源地址每小时 20 条）时等到下一个 UTC 整点后重跑同一轮（号码没注册过，可原样再用）
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const SP = "/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/0d6e0c1f-ceda-4025-9dcf-13a576f15bc5/scratchpad";
const NAMES = "赵钱孙李周吴郑冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐费廉岑薛雷贺倪汤".split("");
const phone = (i) => String(13900072601 + i + Math.floor(i / 9));
const name = (i) => `${NAMES[i]}复测`;
const OUT = join(here, "results-rerun.jsonl");
const CTL = join(here, "raw/fault-control.json");
const s = [];
for (const [form, lat] of [["dev", 0], ["dev", 300], ["prod", 0], ["prod", 300]]) for (const r of [1, 2, 3]) s.push({ tag: `fix-${form}-${lat}-r${r}`, lat, prod: form === "prod" });
s.push({ tag: "fault1-register503", lat: 300, prod: true, fault: true, armA: { fail503: { "/v1/devices/register": 3 } }, postA: 45000, shot: true });
s.push({ tag: "fault1-seat503", lat: 300, prod: true, fault: true, armA: { fail503: { "/v1/seat-token": 3 } }, postA: 45000 });
s.push({ tag: "fault2-enroll-hang", lat: 300, prod: true, fault: true, armB: { hang: ["/v1/auth/devices/enroll"] }, maxB: 330, stopAfterErrMs: 10000, shotErr: true });
// 生产 300 ms 组第一次撞上“这个手机号已注册”（13900072611～613 已被别的会话注册）：RERUN_P300=1 只补这 3 轮，号码从 13900072691 起试，
// 占用就换下一个；第一轮的乙 = 13900072616（杨复测，fault2 的甲，已退出登录）
if (process.env.RERUN_P300 === "1") { s.length = 0; for (const r of [1, 2, 3]) s.push({ tag: `fix-prod-300-r${r}`, lat: 300, prod: true }); }
const plan = s.map((x, i) => ({ ...x, i, phoneA: phone(i), nameA: name(i), phoneB: i === 0 ? "13900072880" : phone(i - 1), nameB: i === 0 ? `${NAMES[58]}测时` : name(i - 1) }));
const from = Number(process.argv[2] ?? 0);
const lastLine = () => { try { const l = readFileSync(OUT, "utf8").trim().split("\n"); return JSON.parse(l[l.length - 1]); } catch { return null; } };
let pool = 13900072691, prevB = ["13900072616", `${NAMES[14]}复测`];
for (const x0 of plan.slice(from)) {
  let x = x0;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (process.env.RERUN_P300 === "1") x = { ...x0, phoneA: String(pool), nameA: `${NAMES[40 + x0.i]}补测`, phoneB: prevB[0], nameB: prevB[1] };
    const cfg = { ...x, ver: "b72", wt: "kimi-legal-b72", webPort: 5761, ud: join(SP, process.env.RERUN_P300 === "1" ? "et/ud8" : "et/ud7", `${x.tag}${attempt ? `-retry${attempt}` : ""}`), out: OUT, controlFile: x.fault ? CTL : null, shot: x.shot ?? x.i % 3 === 0 };
    console.log(`\n===== #${x.i} ${x.tag} A=${x.phoneA} B=${x.phoneB} (${x.nameB}) =====`);
    spawnSync(process.execPath, [join(here, "session.mjs"), JSON.stringify(cfg)], { stdio: "inherit", timeout: 900000 });
    const r = lastLine();
    if (r && r.tag === x.tag && /号码已被占用/.test(r.error ?? "")) { pool++; continue; }
    if (process.env.RERUN_P300 === "1" && r && r.tag === x.tag && !r.error) { prevB = [x.phoneA, x.nameA]; pool++; }
    if (!(r && r.tag === x.tag && /短信限流/.test(r.error ?? ""))) break;
    const next = (Math.floor(Date.now() / 3600_000) + 1) * 3600_000 + 15_000;
    console.log(`短信限流：等到 ${new Date(next).toISOString()} 再跑这一轮`);
    spawnSync("sleep", [String(Math.ceil((next - Date.now()) / 1000))]);
  }
}
console.log("RERUN-DONE");
