import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import rootPkg from "../../package.json" with { type: "json" };

// The iOS app loads its files from the bundle, so no server header applies: the policy of
// packages/server/src/http/middleware.ts goes into the page. A meta policy cannot carry frame-ancestors.
// connect-src stays open: the model calls stream through the WebView fetch to any configured endpoint,
// and the native HTTP plugin is outside this policy anyway.
const SELF = "'self' capacitor://localhost";
const IOS_CSP = [
  `default-src ${SELF}`,
  `style-src ${SELF} 'unsafe-inline'`,
  `script-src ${SELF}`,
  `img-src ${SELF} data: blob:`,
  `font-src ${SELF} data:`,
  `connect-src ${SELF} https: http: data: blob:`,
  `worker-src ${SELF} blob:`,
  "object-src 'none'",
  `base-uri ${SELF}`,
].join("; ");

const iosCsp = (): Plugin => ({
  name: "ios-csp",
  transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: IOS_CSP }, injectTo: "head-prepend" }],
});

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  build: {
    outDir: mode === "ios" ? "dist-ios" : "dist",
  },
  plugins: [tailwindcss(), react(), ...(mode === "ios" ? [iosCsp()] : [])],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    // An address, not "localhost": that name can resolve to ::1, where another program can listen on the same port.
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3579",
        changeOrigin: true,
      },
    },
  },
}));
