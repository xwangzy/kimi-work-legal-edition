/**
 * v9.4 第 25 批界面：审查工作台修改框挡住的范本占位符，与内核放入范本时换上、签修改时再挡的是同一组（复核 Q6-12）。
 * 内核加了占位符时界面跟着改，否则界面放行、内核拒收，律师只看到一条报错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("工作台修改框的占位符清单与内核 HIT_LABEL 一致", () => {
  const kernel = read("../../../packages/kernel/src/services/firm-templates.ts");
  const labels = [...(/const HIT_LABEL[^=]*=\s*\{([^}]*)\}/.exec(kernel)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(labels.length >= 9, "读到内核的占位符清单");
  const ui = /const PLACEHOLDER = \/【\(([^)]*)\)】\//.exec(read("../src/components/ReviewWorkbench.tsx"))?.[1]?.split("|") ?? [];
  assert.deepEqual([...ui].sort(), [...labels].sort());
});

test("审定 AI 起草的审查要点：名称去掉“草稿”字样（走查：启用后的在用版本曾叫“……（买方，草稿）”）", async () => {
  const { stripDraftMark } = await import("../src/lib/rules-title.ts");
  const cases: [string, string][] = [
    ["采购合同审查要点（草稿）", "采购合同审查要点"],
    ["采购合同审查要点（买方，草稿）", "采购合同审查要点（买方）"],
    ["采购合同审查要点(草稿)", "采购合同审查要点"],
    ["采购合同审查要点（草稿，买方版）", "采购合同审查要点（买方版）"],
    ["采购合同审查要点【草稿】", "采购合同审查要点"],
    ["采购合同审查要点 - 草稿", "采购合同审查要点"],
    ["客户甲采购标准", "客户甲采购标准"],
    ["草稿纸采购合同审查要点（买方）", "草稿纸采购合同审查要点（买方）"],
  ];
  for (const [i, o] of cases) assert.equal(stripDraftMark(i), o, i);
  assert.match(read("../src/components/MatterSetup.tsx"), /useState\(draft \? stripDraftMark\(plain\(draft\.title\)\)/);
});

test("预览交付包：按内核给的“同一份文件是否最新”判断，别的任务的同类成果不再把已签发的那份算作被取代", async () => {
  const { deliveryPackage } = await import("../src/lib/deliverables.ts");
  const rows = [
    { artifact_version_id: "a", kind: "agent_report", version: 1, audience: "client", status: "approved", is_latest: true },
    { artifact_version_id: "b", kind: "agent_report", version: 1, audience: "client", status: "draft", is_latest: true },
    { artifact_version_id: "c", kind: "agent_report", version: 1, audience: "client", status: "approved", is_latest: false },
  ];
  const p = deliveryPackage(rows);
  assert.deepEqual(p.ready.map((r) => r.artifact_version_id), ["a"]);
  assert.deepEqual(p.held.map((h) => [h.row.artifact_version_id, h.reason]), [["b", "not_signed"], ["c", "superseded"]]);
  // 旧内核没有 is_latest：仍按种类推算
  assert.equal(deliveryPackage([{ artifact_version_id: "x", kind: "k", version: 1, status: "approved", audience: "client" }, { artifact_version_id: "y", kind: "k", version: 2, status: "draft", audience: "client" }]).held[0]!.reason, "superseded");
});

test("复核页：理由不足 4 字时说明原因；签发后不再显示输入框，签发人一行写出理由", () => {
  const r = read("../src/pages/Review.tsx");
  assert.match(r, /\{outlineOpen && pending && \(/);
  assert.match(r, /理由至少写 4 个字/);
  assert.match(r, /不确认论点就签发的理由：\$\{data\.approved_by\.outline_unconfirmed_reason\}/);
});
