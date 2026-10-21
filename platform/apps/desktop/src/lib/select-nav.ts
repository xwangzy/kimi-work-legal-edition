/**
 * 统一下拉框（Z3 #15、V-c）的键盘导航：纯函数，跳过不可选项，供 components/Select.tsx 与用例共用。
 */
export type SelectOption = { value: string; label: string; disabled?: boolean; hint?: string };

export type NavKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/** 从 from 出发按键移动到下一项可选项；没有可选项返回 -1；到头不回绕（与原生下拉框一致）。 */
export function moveActive(options: readonly SelectOption[], from: number, key: NavKey): number {
  const ok = (i: number) => i >= 0 && i < options.length && !options[i]!.disabled;
  if (key === "Home" || key === "End") {
    const order = options.map((_, i) => i);
    if (key === "End") order.reverse();
    return order.find(ok) ?? -1;
  }
  const step = key === "ArrowDown" ? 1 : -1;
  for (let i = from + step; i >= 0 && i < options.length; i += step) if (ok(i)) return i;
  return ok(from) ? from : moveActive(options, -1, "Home");
}

/** 打开时先停在当前值；当前值不可选或没有值时停在第一项可选项。 */
export function initialActive(options: readonly SelectOption[], value: string): number {
  const i = options.findIndex((o) => o.value === value && !o.disabled);
  return i >= 0 ? i : moveActive(options, -1, "Home");
}

/** 键入首字跳转（中文按拼音首字母做不到，这里按标签首字符匹配，从当前项之后找起，回绕一次）。 */
export function typeahead(options: readonly SelectOption[], from: number, ch: string): number {
  if (!ch || ch.length !== 1) return from;
  const c = ch.toLowerCase();
  for (let k = 1; k <= options.length; k++) {
    const i = (from + k) % options.length;
    const o = options[i]!;
    if (!o.disabled && o.label.toLowerCase().startsWith(c)) return i;
  }
  return from;
}

/** 显示的文字：选中项的标签；没有选中时用占位文字。 */
export function displayLabel(options: readonly SelectOption[], value: string, placeholder = "请选择"): string {
  return options.find((o) => o.value === value)?.label ?? placeholder;
}
