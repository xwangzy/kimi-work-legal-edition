/**
 * 云端模型目录 → 选择器选项（第 66 批 V40 P0-4）。纯函数，首页、开始面板共用。
 * 不可用的（套餐不含、已停用、未定价、无线路、不支持工具调用）照样列出、置灰并写原因，律师知道“有这个模型、为什么不能选”。
 */
import type { ModelCatalogView } from "../api.ts";
import type { ModelChoice } from "../components/ModelPicker.tsx";

export function modelChoices(v: Pick<ModelCatalogView, "models" | "default">): ModelChoice[] {
  return v.models.map((m) => ({ id: m.id, label: m.label, description: m.description, available: m.available, reasonText: m.reason_text, isDefault: m.id === v.default }));
}

/** 当前所选模型的显示名（找不到时回到缺省；都没有为 null）。 */
export function modelLabelOf(v: Pick<ModelCatalogView, "models" | "default" | "selected"> | null | undefined): string | null {
  if (!v) return null;
  return (v.models.find((m) => m.id === v.selected) ?? v.models.find((m) => m.id === v.default))?.label ?? null;
}
