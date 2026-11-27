// 收尾：在某个数据目录里打开应用、退出当前登录的账号（释放该账号的同时登录名额）。node signout.mjs <user-data-dir>
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const SP = "/private/tmp/claude-501/-Users-wangzeyu-Documents-Coding-Kimi-Work-Legal/0d6e0c1f-ceda-4025-9dcf-13a576f15bc5/scratchpad";
const PLAT = "/Users/wangzeyu/Documents/Coding/Kimi Work Legal/.claude/worktrees/kimi-legal-b72/platform";
const { _electron } = createRequire("/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/")("playwright");
const env = { ...process.env };
for (const l of readFileSync(join(SP, "tools/stack/client.env"), "utf8").split("\n")) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l); if (m) env[m[1]] = m[2]; }
for (const k of ["ZR_KERNEL_DATA_DIR", "ZR_DESKTOP_DEV_URL", "ELECTRON_RUN_AS_NODE", "ZR_FIRM_SLUG", "ZR_USER_SLUG"]) delete env[k];
Object.assign(env, { ZR_DESKTOP_PROD: "1", ZR_KERNEL_TCP: "off", ZR_BACKUP_TIMER: "off", ZR_DEMO_SAMPLES: "0", ZR_DESKTOP_RUNTIME_DIR: join(SP, "et/rt-b72") });
const app = await _electron.launch({ executablePath: createRequire(join(PLAT, "package.json"))("electron"), args: [join(PLAT, "apps/desktop"), `--user-data-dir=${process.argv[2]}`, "--use-mock-keychain"], env, timeout: 90000 });
const page = await app.firstWindow();
const btn = (re) => page.locator("button:visible").filter({ hasText: re });
try {
  await page.waitForFunction(() => /新建任务/.test(document.body.innerText), null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => { location.hash = "#/connections/account"; });
  await page.waitForTimeout(1500);
  await btn(/^\s*退出登录\s*$/).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "退出登录" }).click();
  await page.waitForFunction(() => /你已退出登录/.test(document.body.innerText), null, { timeout: 60000 });
  console.log("SIGNED-OUT", process.argv[2].split("/").pop());
} catch (e) { console.log("SIGNOUT-ERR", String(e.message).slice(0, 200)); }
await app.close().catch(() => {});
