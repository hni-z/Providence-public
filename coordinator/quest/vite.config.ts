import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { runtimeNoticesPlugin } from "../scripts/runtime-notices.mjs";
export default defineConfig({
  base: "/quest/",
  plugins: [runtimeNoticesPlugin(fileURLToPath(new URL(".", import.meta.url)), "/quest/")],
  server: {
    port: 5183,
    proxy: {
      "/v1": "http://127.0.0.1:8787",
      "/client": "http://127.0.0.1:8787",
    },
  },
});
