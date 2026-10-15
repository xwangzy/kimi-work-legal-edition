import React from "react";
import { createRoot } from "react-dom/client";
import "@zr-legal/design-tokens/tokens.css";
import "./styles.css";
import { App } from "./App.tsx";
import { applyUiZoom, readUiZoom } from "./lib/ui-prefs.ts";

// 设置 → 通用 → 字号：首次渲染前应用，避免闪动
applyUiZoom(readUiZoom());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
