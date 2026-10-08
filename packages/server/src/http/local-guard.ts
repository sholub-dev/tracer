import { timingSafeEqual } from "node:crypto";
import type { Http2Bindings, HttpBindings } from "@hono/node-server";

type Bindings = HttpBindings | Http2Bindings;

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostName(host: string | null): string {
  if (!host) return "";
  return (host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]).toLowerCase();
}

function isLoopbackAddress(addr: string | undefined): boolean {
  return !!addr && (addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127."));
}

export function isLoopbackBind(bindHost: string): boolean {
  return bindHost === "localhost" || bindHost === "::1" || bindHost.startsWith("127.");
}

function tokenMatches(header: string | null, token: string): boolean {
  const given = Buffer.from(header?.match(/^Bearer (.+)$/i)?.[1] ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Rejects requests whose Host header is not a loopback name while the server listens on loopback, so a web page
 * that rebinds its own domain to 127.0.0.1 cannot call the API. The copy routes hand out every stored secret,
 * so they also need a loopback Host and a loopback peer when the server is exposed with TRACER_HOST.
 * An exposed server requires the bearer `token` on every /api request from a non-loopback peer.
 * A loopback peer is the owner's own machine, so the bundled web UI works there without the token.
 */
export function guardLocalRequests(
  fetchImpl: (req: Request, env: Bindings) => Response | Promise<Response>,
  bindHost: string,
  allowedOrigins: string[] = [],
  token: string | null = null,
) {
  const listensOnLoopback = isLoopbackBind(bindHost);
  return (req: Request, env: Bindings) => {
    const localHost = LOOPBACK_NAMES.has(hostName(req.headers.get("host")));
    if (listensOnLoopback && !localHost) return new Response("Forbidden", { status: 403 });
    // tRPC percent-decodes the procedure path, so "transfer%2Esend" must match too.
    let path = new URL(req.url).pathname;
    try { path = decodeURIComponent(path); } catch { /* tRPC rejects a malformed path too */ }
    if (!listensOnLoopback && token && !isLoopbackAddress(env.incoming.socket.remoteAddress) && path.startsWith("/api/") && !tokenMatches(req.headers.get("authorization"), token)) {
      return new Response("Unauthorized", { status: 401 });
    }
    if (path.startsWith("/api/trpc/") && path.includes("transfer.") && !(localHost && isLoopbackAddress(env.incoming.socket.remoteAddress))) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      // A cross-site form or no-cors fetch can send a text/plain body that the JSON routes still parse.
      const origin = req.headers.get("origin");
      const sameOrigin = !!origin && origin.replace(/^https?:\/\//, "") === req.headers.get("host");
      if (origin && !sameOrigin && !allowedOrigins.includes(origin)) return new Response("Forbidden", { status: 403 });
      if (req.headers.get("sec-fetch-site") === "cross-site") return new Response("Forbidden", { status: 403 });
      if (path.startsWith("/api/") && !path.startsWith("/api/trpc/")) {
        const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (type !== "application/json") return new Response("Unsupported Media Type", { status: 415 });
      }
    }
    return fetchImpl(req, env);
  };
}
