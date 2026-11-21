#!/usr/bin/env node
// 本机用例的“产物齐全”自检（第 55 批 K5；审计 B 6.1）：npm test 最先跑这一步。
//
// 为什么要有：新检出的 worktree 缺法规库、助手设定、工具清单、方法、内容签名密钥或 OCR 模型时，内核用例会一直等而不报错
// （曾挂 1 小时 46 分）。这里只查文件在不在（不到 1 秒），缺了就以 1 退出，并逐项写明缺什么、怎么补。
// 不改变 CI：CI 直接调用 scripts/run-tests-watchdog.mjs，不经 npm test。
//
// 用法：node scripts/check-test-prereqs.mjs（在 platform/ 下）；也可 import { missingTestPrereqs } 供用例自测。
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** [相对 platform/ 的路径, 说明, 怎么补] */
export const TEST_PREREQS = [
  ["content/lawdb/dist/lawdb.sqlite", "随包法规库", "npm run build:lawdb"],
  ["content/lawdb/test-fixtures/lawdb-renumber-demo.sqlite", "法规库测试夹具", "npm run build:lawdb"],
  ["content/agent-profile/dist/legal-agent.manifest.json", "助手设定", "npm run build:agent-profile"],
  ["content/tool-manifest/dist/tool-manifest.lock.json", "工具清单", "npm run build:tool-manifest"],
  ["content/skills/dist/skills.manifest.json", "方法包", "npm run build:skills"],
  ["content/keys/content-signing-dev.json", "开发内容签名密钥", "从主检出复制 content/keys/（与已签内容同一把）；没有现成的，npm run build:lawdb 会新生成一把"],
  ["content/keys/content-signing-dev.pub.json", "开发内容签名公钥", "同上：从主检出复制 content/keys/"],
  ["content/ocr-models/ch_PP-OCRv5_det_mobile.onnx", "OCR 检测模型", "npm run fetch:ocr-models（或从主检出复制 content/ocr-models/）"],
  ["content/ocr-models/ch_PP-OCRv5_rec_mobile.onnx", "OCR 识别模型", "npm run fetch:ocr-models（或从主检出复制 content/ocr-models/）"],
  ["content/ocr-models/ppocrv5_dict.txt", "OCR 字典", "npm run fetch:ocr-models（或从主检出复制 content/ocr-models/）"],
];

/** 缺的各项（rel、说明、怎么补）；exists 可替换，供用例在假目录上自测。 */
export function missingTestPrereqs(root = ROOT, exists = existsSync) {
  return TEST_PREREQS.filter(([rel]) => !exists(join(root, rel))).map(([rel, what, fix]) => ({ rel, what, fix }));
}

/** 依赖链接：node_modules/@zr-legal 下要有工作区包（新 worktree 常见漏项）。 */
export function missingWorkspaceLinks(root = ROOT) {
  const dir = join(root, "node_modules", "@zr-legal");
  if (!existsSync(dir)) return ["node_modules/@zr-legal（先在 platform/ 下运行 npm install，或从主检出复制 node_modules/）"];
  try {
    return readdirSync(dir).length === 0 ? ["node_modules/@zr-legal 是空目录（先运行 npm install）"] : [];
  } catch {
    return ["node_modules/@zr-legal 读不了（先运行 npm install）"];
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const miss = missingTestPrereqs();
  const links = missingWorkspaceLinks();
  if (miss.length === 0 && links.length === 0) {
    console.log(`用例产物齐全（${TEST_PREREQS.length} 项）`);
    process.exit(0);
  }
  console.error("缺少用例运行所需的产物，内核用例会挂起而不是报错，先补齐再跑：");
  for (const m of miss) console.error(`  - ${m.rel}（${m.what}）：${m.fix}`);
  for (const l of links) console.error(`  - ${l}`);
  console.error("前五项可一次补齐：npm run pretest。");
  process.exit(1);
}
