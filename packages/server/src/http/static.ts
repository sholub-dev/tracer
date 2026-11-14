import { readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { getMimeType } from "hono/utils/mime";

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
  const found = webCandidates.find((d) => existsSync(resolve(d, "index.html")));
  if (!found) return;
  const webRoot = realpathSync.native(found);

  const indexHtml = readFileSync(resolve(webRoot, "index.html"), "utf-8");

  // dist is immutable for the lifetime of the process — cache file bodies so
  // repeat requests skip synchronous fs calls on the event loop.
  const fileCache = new Map<string, { body: Buffer<ArrayBuffer>; headers: Record<string, string> }>();

  app.use("*", async (c, next) => {
    const reqPath = c.req.path.slice(1);
    if (!reqPath) { await next(); return; }
    // Keyed on the path as it is on disk: "/assets//a.js", "/assets/a.js/" and, on a case-insensitive disk, "/assets/A.JS" name the same file.
    const requested = resolve(webRoot, reqPath);
    let file = fileCache.get(requested);
    if (!file) {
      let filePath: string;
      try {
        filePath = realpathSync.native(requested);
      } catch {
        await next();
        return;
      }
      if (!filePath.startsWith(webRoot + sep)) { await next(); return; }
      file = fileCache.get(filePath);
      if (!file) {
        if (statSync(filePath).isDirectory()) {
          await next();
          return;
        }
        const mime = getMimeType(filePath) ?? "application/octet-stream";
        const headers: Record<string, string> = { "Content-Type": mime };
        if (filePath.startsWith(resolve(webRoot, "assets") + sep)) {
          headers["Cache-Control"] = "public, max-age=31536000, immutable";
        }
        file = { body: readFileSync(filePath), headers };
        fileCache.set(filePath, file);
      }
    }
    return c.body(file.body, { headers: file.headers });
  });
  // no-cache (revalidate, don't skip) so a self-update never serves a stale
  // shell pointing at old hashed chunks.
  app.get("*", (c) => c.req.path.startsWith("/api/") ? c.json({ error: "Not found" }, 404) : c.html(indexHtml, 200, { "Cache-Control": "no-cache" }));
}
