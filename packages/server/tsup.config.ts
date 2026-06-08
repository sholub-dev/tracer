import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: false,
  noExternal: [/^(?!better-sqlite3).*/],
  external: ["better-sqlite3"],
  // Some bundled deps (e.g. @vercel/oidc) use CommonJS require(). esbuild's ESM
  // output turns those into a shim that throws unless a real `require` exists in
  // module scope, so provide one via createRequire.
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});
