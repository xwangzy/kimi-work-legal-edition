/**
 * 侧栏展开 / 收起状态（第 49 批：唯一来源）。
 *
 * 根因（第 48 批截图里收起态图标叠在一起）：
 * ① “收起”有两套各自维护的规则——手动收起与执行态用 .sidebar.compact，窄窗口（≤900px）另用 @media 直接改 .sidebar，
 *    两套逐渐漂移（窄窗口下“新建任务”的 ⌘K 键帽没隐藏、品牌行内边距与固定高度冲突）；
 * ② Work / Chat 分段在收起时改为竖排，但选项仍是 flex: 1（基准 0%）——竖排时主轴变成高度，height: 32px 不再生效，
 *    两个选项被压成约 21px 高、图标上下贴在一起。
 * 现在收起与否只由这里算出，CSS 只认 .compact 一个类；执行态与窄窗口属于“自动收起”，律师仍可临时展开（换页即恢复）。
 */
export interface SidebarStateInput {
  /** 律师手动收起（记在本机偏好）。 */
  collapsedPref: boolean;
  /** 执行态三栏页面：缺省收起，给材料 | 进度 | 预览让宽度。 */
  forced: boolean;
  /** 窗口窄于 900px：缺省收起。 */
  narrow: boolean;
  /** 自动收起时律师点了展开（临时，换页或窗口宽窄变化即复位）。 */
  peek: boolean;
}

export interface SidebarState {
  /** 显示为图标栏。 */
  compact: boolean;
  /** 当前是自动收起（执行态或窄窗口），切换只改临时 peek、不改偏好。 */
  auto: boolean;
}

export function sidebarState(i: SidebarStateInput): SidebarState {
  const auto = i.forced || i.narrow;
  return { compact: auto ? !i.peek : i.collapsedPref, auto };
}

/** 窄窗口的界限（与 styles.css 主区窄窗口规则同一数值）。 */
export const NARROW_QUERY = "(max-width: 900px)";
