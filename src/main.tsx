import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// No webview menu (Back/Refresh/Inspect); text in inputs and the log stays selectable.
window.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
