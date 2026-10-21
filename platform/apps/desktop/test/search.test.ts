/**
 * 全局搜索（Z3 评审 §8.2 #31；余项续复核 RC-B-06/08）：匹配在内核（search.titles），界面只排三组。
 * 任务标题带目标、副标题带事项与时刻；交付件带版本；Ctrl / ⌘ + K 打开（macOS 只认 ⌘），开通向导里不开；输入法组字不当选择。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { searchGroups, searchLabels } from "../src/lib/search.ts";

test("分组：同一事项的几次任务按目标区分；交付件带版本与时刻", () => {
  const now = new Date(2026, 9, 21, 16, 0).getTime();
  const at = new Date(2026, 9, 20, 15, 2).toISOString();
  const g = searchGroups(
    {
      matters: [{ matter_id: "m1", title: "甲公司股权转让", sub: "乙投资" }],
      runs: [
        { run_id: "r1", matter_id: "m1", matter_title: "甲公司股权转让", scenario: "a1.agent_task", skill: "contract-review", goal: "审查股权转让协议 v1", updated_at: at },
        { run_id: "r2", matter_id: "m1", matter_title: "甲公司股权转让", scenario: "a1.agent_task", skill: "contract-review", goal: "审查对方回稿", updated_at: at },
      ],
      deliverables: [{ artifact_version_id: "a1", matter_id: "m1", matter_title: "甲公司股权转让", kind: "revision_draft", version: 2, filename: "x.docx", title: null, created_at: at }],
    },
    now,
  );
  assert.deepEqual(g.map((x) => x.kind), ["matter", "run", "deliverable"]);
  const runs = g[1]!.items.map((x) => x.title);
  assert.notEqual(runs[0], runs[1], "两次任务标题不同");
  assert.match(runs[0]!, /审查股权转让协议 v1/);
  assert.equal(g[1]!.items[0]!.sub, "甲公司股权转让 · 10月20日 15:02");
  assert.match(g[2]!.items[0]!.title, /第 2 版$/);
  assert.deepEqual(searchGroups({ matters: [], runs: [], deliverables: [] }), []);
});

test("给内核的标签含场景卡名与交付件名", () => {
  const l = searchLabels();
  assert.ok(l["skill:contract-review"]);
  assert.ok(l["kind:revision_draft"] || l["kind:s1_redline"]);
  assert.match(l["scenario:s2.case_file"]!, /整理案卷/);
  assert.match(l["scenario:s2.case_file"]!, /材料整理/, "任务表里的叫法也能搜到（走查发现）");
});

test("Ctrl / ⌘ + K 打开搜索（macOS 只认 ⌘、开通向导里不开）；侧栏有入口；组字时不当选择；Esc 不连带关掉底下的对话框", () => {
  const app = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");
  assert.match(app, /e\.key\.toLowerCase\(\) === "k" && !onboardingRef\.current/);
  assert.match(app, /\/Mac\/i\.test\(navigator\.platform\) \? e\.metaKey && !e\.ctrlKey/);
  assert.match(app, /<SearchPalette/);
  assert.match(readFileSync(fileURLToPath(new URL("../src/components/Sidebar.tsx", import.meta.url)), "utf8"), /kwl:search/);
  const pal = readFileSync(fileURLToPath(new URL("../src/components/SearchPalette.tsx", import.meta.url)), "utf8");
  assert.match(pal, /isComposing\) return/);
  assert.match(pal, /aria-modal="true"/);
  assert.match(pal, /stopPropagation\(\);\s*onClose\(\)/);
  assert.match(pal, /api\s*\.searchTitles\(/);
  assert.doesNotMatch(pal, /restoreTokens|listArtifacts/, "不再在界面里批量取交付件并还原代号（复核 RC-A-05）");
});
