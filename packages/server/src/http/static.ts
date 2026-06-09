import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serves the web SPA from the built dist directory.
 * Tries multiple candidate paths (npm install layout vs dev build).
 */
export function mountStaticFiles(app: Hono): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const webCandidates = [
    resolve(__dirname, "../../web/dist"),        // npm install: packages/server/dist/../../web/dist
    resolve(process.cwd(), "packages/web/dist"), // dev production build from repo root
  ];
  const webRoot = webCandidates.find((d) => existsSync(resolve(d, "index.html")));
  if (!webRoot) return;

  const indexHtml = readFileSync(resolve(webRoot, "index.html"), "utf-8");

  // dist is immutable for the lifetime of the process — cache file bodies so
  // repeat requests skip synchronous fs calls on the event loop.
  const fileCache = new Map<string, { body: Buffer<ArrayBuffer>; headers: Record<string, string> }>();

  app.use("*", async (c, next) => {
    const reqPath = c.req.path.slice(1);
    if (!reqPath) { await next(); return; }
    let file = fileCache.get(reqPath);
    if (!file) {
      const filePath = resolve(webRoot, reqPath);
      if (!filePath.startsWith(webRoot) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        await next();
        return;
      }
      const mime = MIME_TYPES[extname(filePath)] || "application/octet-stream";
      const headers: Record<string, string> = { "Content-Type": mime };
      if (reqPath.startsWith("assets/")) {
        headers["Cache-Control"] = "public, max-age=31536000, immutable";
      }
      file = { body: readFileSync(filePath), headers };
      fileCache.set(reqPath, file);
    }
    return c.body(file.body, { headers: file.headers });
  });
  // no-cache (revalidate, don't skip) so a self-update never serves a stale
  // shell pointing at old hashed chunks.
  app.get("*", (c) => c.html(indexHtml, 200, { "Cache-Control": "no-cache" }));
}
