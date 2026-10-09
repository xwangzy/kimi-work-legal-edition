import React from "react";
import { createRoot } from "react-dom/client";
import "@zr-legal/design-tokens/tokens.css";
import "./styles.css";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
