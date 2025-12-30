import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { registerSW } from "virtual:pwa-register";

// Ensure SW updates are applied promptly (prevents old cached broken bundles)
registerSW({
  immediate: true,
  onNeedRefresh() {
    // auto-reload to the fresh version
    window.location.reload();
  },
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
