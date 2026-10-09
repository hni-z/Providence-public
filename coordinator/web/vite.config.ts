import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { runtimeNoticesPlugin } from "../scripts/runtime-notices.mjs";
export default defineConfig({
  plugins: [react(), runtimeNoticesPlugin(fileURLToPath(new URL(".", import.meta.url)))],
  build: { assetsInlineLimit: 0, rollupOptions: { input: { main: "index.html", account: "account.html", privacy: "privacy.html" } } },
  server: {
    proxy: {
      "/v1": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
      "/client": "http://127.0.0.1:8787",
      "/bootstrap": "http://127.0.0.1:8787",
    },
  },
});
