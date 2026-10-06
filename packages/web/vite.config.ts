import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { FEATURES } from "../shared/src/feature-flags";
import rootPkg from "../../package.json" with { type: "json" };

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
    __DASHBOARDS__: JSON.stringify(FEATURES.dashboards),
  },
  build: {
    outDir: mode === "ios" ? "dist-ios" : "dist",
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3579",
        changeOrigin: true,
      },
    },
  },
}));
