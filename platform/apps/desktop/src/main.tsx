import React from "react";
import { createRoot } from "react-dom/client";
import "@zr-legal/design-tokens/tokens.css";
import "./styles.css";
import "./styles-window.css";
import { App } from "./App.tsx";
import { applyWindowChrome } from "./lib/window-chrome.ts";
import { windowBridge } from "./api.ts";
import { applyUiTheme, applyUiZoom, readUiTheme, readUiZoom } from "./lib/ui-prefs.ts";

// 设置 → 通用 → 字号与外观：首次渲染前应用，避免闪动
applyUiZoom(readUiZoom());
applyUiTheme(readUiTheme());
// 第 64 批：无边框窗口（顶部拖动条、红绿灯 / 窗口控件让位、控件浮层随明暗换色）
applyWindowChrome(windowBridge());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
