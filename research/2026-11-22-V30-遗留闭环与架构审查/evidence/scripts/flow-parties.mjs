// 当事人信息真点：填我方单位 5 项 + 对方自然人 3 项 → 保存 → 材料内容 → 再打开回填 → 改一项 → 仍一份 → 起诉状开始面板
import { chromium } from "/Users/wangzeyu/.nvm/versions/node/v26.8.1/lib/node_modules/playwright/index.mjs";
const MID = "mat_3b38f26e-4c46-4e71-807e-7f3b47efd2ad";
const OUT = process.argv[2];
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const go = async (hash) => { await p.goto(`http://127.0.0.1:5601/${hash}`); await p.waitForTimeout(2500); };
await go(`#/matter/${MID}`);
await p.getByText("概览", { exact: true }).first().click();
await p.waitForTimeout(800);
await p.getByRole("button", { name: /^(现在填|修改)$/ }).first().click();
await p.waitForTimeout(800);
const dlg = p.getByRole("dialog", { name: "当事人信息" });
const g = (i) => dlg.locator("section.pi-group").nth(i);
// 我方：单位
await g(0).getByLabel("统一社会信用代码").fill("91310115MA1H7K2X3Q");
await g(0).getByLabel("住所").fill("上海市浦东新区张江路 1288 号 3 幢 501 室");
await g(0).getByLabel("法定代表人").fill("王建国");
await g(0).getByLabel("职务").fill("执行董事");
await g(0).getByLabel("联系电话").fill("021-58881234");
// 对方：改成自然人
await g(1).getByRole("radio", { name: "自然人" }).click();
await g(1).getByLabel("姓名").fill("李秀英");
await g(1).getByLabel("身份证号").fill("110105198503021241");
await g(1).getByLabel("住址").fill("北京市朝阳区建国路88号院2号楼1203室");
await g(1).getByLabel("联系电话").fill("13912345678");
await p.screenshot({ path: `${OUT}-对话框.png` });
await dlg.getByRole("button", { name: "保存" }).click();
await p.waitForTimeout(2000);
await p.screenshot({ path: `${OUT}-概览.png` });
console.log("概览：", await p.locator(".pi-row").innerText());
// 再打开回填
await p.getByRole("button", { name: "修改" }).first().click();
await p.waitForTimeout(1200);
const vals = await dlg.locator("input").evaluateAll((els) => els.map((e) => e.value).filter(Boolean));
console.log("回填：", JSON.stringify(vals));
await g(0).getByLabel("联系电话").fill("021-58889999");
await dlg.getByRole("button", { name: "保存" }).click();
await p.waitForTimeout(2000);
console.log("改后概览：", await p.locator(".pi-row").innerText());
await b.close();
