// 崩毁重建测试用：首次运行崩毁（写标记文件），第二次运行走正常 mock 输出
// 环境变量 KWL_CRASH_MARK 指向标记文件路径
import { existsSync, writeFileSync } from "node:fs";

const mark = process.env.KWL_CRASH_MARK ?? "";
if (mark && !existsSync(mark)) {
  writeFileSync(mark, "crashed-once");
  console.error("[crash-once-worker] 模拟首次崩毁");
  process.exit(2);
}

// 第二次：按协议输出一页 mock 结果并 done
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const req = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const out = { pageNo: 1, kind: "scanned", quality: "ok", text: "重建后恢复文本", meanScore: 0.95, rss: 0 };
process.stdout.write(JSON.stringify({ id: req.id, t: "page", ...out }) + "\n");
process.stdout.write(JSON.stringify({ id: req.id, t: "done", pageCount: 1, peakRss: 0 }) + "\n");
