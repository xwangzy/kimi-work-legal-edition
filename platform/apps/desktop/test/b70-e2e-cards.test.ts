/**
 * 第 70 批：Windows 真实联调的任务卡（desktop-repo/template/scripts/e2e/cards/*.json）里写的栏名必须是开始面板上现有的栏名。
 * 第 66 批把“同时出一份建议修订稿”改名为“建议修订稿”，卡片没跟着改；第 66～69 批都没在 Windows 跑任务，到第 70 批运行 45779137787 才在开始面板上等 20 秒超时。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCENARIOS } from "../src/lib/scenarios.ts";

// monorepo 里在 desktop-repo/template/scripts/e2e/cards；导出的桌面仓库里在仓库根的 scripts/e2e/cards
const dir = [new URL("../../../desktop-repo/template/scripts/e2e/cards/", import.meta.url), new URL("../../../scripts/e2e/cards/", import.meta.url)].find((u) => existsSync(fileURLToPath(u)))!;

test("e2e 任务卡：卡片编号存在；写的每个栏名都在这张卡的开始面板上；胶囊 / 下拉的选项都存在", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const c = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { id: string; fields?: Record<string, string | string[]> };
    const card = SCENARIOS.find((s) => s.id === c.id);
    assert.ok(card, `${f}：没有卡片 ${c.id}`);
    for (const [label, v] of Object.entries(c.fields ?? {})) {
      // 驱动按“.ss-label 含这段文字”找栏：卡上须有一栏的标签包含它
      const field = card!.fields.find((x) => x.label.includes(label));
      assert.ok(field, `${f}：卡片 ${c.id} 上没有“${label}”这一栏（现有：${card!.fields.map((x) => x.label).join("、")}）`);
      const vals = Array.isArray(v) ? v : field!.kind === "select" ? [v] : [];
      for (const x of vals) assert.ok(field!.options?.includes(x), `${f}：“${label}”没有选项“${x}”`);
    }
  }
});
