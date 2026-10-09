// env 白名单测试用：报告子进程内可见的环境变量（验证机密不泄漏、PATH 存在）
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const out = {
  pageNo: 1,
  kind: "text",
  quality: "ok",
  text: "env-probe",
  rss: 0,
  env: {
    ZR_MAAS_TOKEN: typeof process.env.ZR_MAAS_TOKEN,
    ZR_DB_KEY: typeof process.env.ZR_DB_KEY,
    ZR_INTERNAL_SECRET: typeof process.env.ZR_INTERNAL_SECRET,
    PATH: typeof process.env.PATH,
  },
};
process.stdout.write(JSON.stringify({ id: req.id, t: "page", ...out }) + "\n");
process.stdout.write(JSON.stringify({ id: req.id, t: "done", pageCount: 1, peakRss: 0 }) + "\n");
