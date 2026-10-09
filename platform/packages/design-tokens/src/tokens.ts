/** 设计令牌的 TS 镜像（与 tokens.css 保持一致；改动须同步）。 */
export const tokens = {
  bgSidebar: "#fbfaf9",
  bgMain: "#ffffff",
  textPrimary: "#0e1219",
  textSecondary: "#888888",
  accent: "#167ffb",
  btnPrimary: "#191919",
  radiusInput: "16px",
  sidebarWidth: "260px",
  previewWidth: "45%",
  risk: { high: "#d92d20", mid: "#dc6803", low: "#b54708" },
  riskBg: { high: "#fef3f2", mid: "#fffaeb", low: "#fffcf5" },
  status: { valid: "#067647", amended: "#175cd3", repealed: "#667085" },
  statusBg: { valid: "#ecfdf3", amended: "#eff4ff", repealed: "#f2f4f7" },
  highlight: { citation: "#fef0c7", risk: "#fee4e2", revision: "#d1e0ff" },
  cite: {
    sourceVerified: "#067647",
    versionVerified: "#175cd3",
    supportPending: "#b54708",
    lawyerConfirmed: "#5925dc",
    intercepted: "#d92d20",
  },
  type: {
    readingSize: "16px",
    readingLeading: 1.75,
    tableSize: "13px",
    tableLeading: 1.6,
    weights: [400, 500, 600] as const,
  },
} as const;

export type Tokens = typeof tokens;
