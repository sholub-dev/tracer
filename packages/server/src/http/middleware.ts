import type { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { CONFIG } from "../config.js";

export function applyMiddleware(app: Hono): void {
  app.use("*", logger((msg: string, ...rest: string[]) => {
    // The query string can carry credentials, so the log keeps the path only.
    let line = msg.replace(/\?\S*/, "");
    try { line = decodeURIComponent(line); } catch { /* keep the raw line */ }
    console.log(line, ...rest);
  }));
  app.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      // React and the chart component emit inline style attributes and a <style> tag.
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  }));
  app.use("*", cors({ origin: CONFIG.corsOrigin ?? `http://localhost:${CONFIG.port}` }));
}
