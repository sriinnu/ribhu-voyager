import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { session } from "./session";
import "./styles.css";

void session.start();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline shell is a progressive enhancement */
    });
  });
}
