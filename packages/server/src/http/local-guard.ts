import { timingSafeEqual } from "node:crypto";
import { markOwnerRequest } from "../trpc/context.js";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostName(host: string | null): string {
  if (!host) return "";
  return (host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0]).toLowerCase();
}

export function isLoopbackBind(bindHost: string): boolean {
  return bindHost === "::1" || bindHost.startsWith("127.");
}

const matches = (given: Buffer, expected: Buffer | null) =>
  !!expected && given.length === expected.length && timingSafeEqual(given, expected);

const unauthorized = () => new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });

/**
 * Every /api request must carry a bearer credential: the address of the caller proves nothing, because other
 * local users, containers and same-host proxies all connect from loopback. The `sessionToken` opens every route.
 * The optional `token` (TRACER_TOKEN) opens every route too, but only a request with the `sessionToken` gets the owner
 * mark, which the copy procedures require: they hand out every stored secret.
 * Requests whose Host header is not a loopback name while the server listens on loopback are rejected, so a web page
 * that rebinds its own domain to 127.0.0.1 cannot reach the server; a request with a credential is not such a page.
 */
export function guardLocalRequests<Env>(
  fetchImpl: (req: Request, env: Env) => Response | Promise<Response>,
  bindHost: string,
  allowedOrigins: string[],
  sessionToken: string,
  token: string | null = null,
) {
  const listensOnLoopback = isLoopbackBind(bindHost);
  const ownerSecret = sessionToken ? Buffer.from(sessionToken) : null;
  const remoteSecret = token ? Buffer.from(token) : null;
  return (req: Request, env: Env) => {
    let known: "owner" | "remote" | null | undefined;
    const credential = () => {
      if (known === undefined) {
        const given = Buffer.from(req.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1] ?? "");
        known = matches(given, ownerSecret) ? "owner" : matches(given, remoteSecret) ? "remote" : null;
      }
      return known;
    };
    if (listensOnLoopback && !LOOPBACK_NAMES.has(hostName(req.headers.get("host"))) && !credential()) {
      return new Response("Forbidden", { status: 403 });
    }
    // The router percent-decodes the path, so "/%61pi/..." is an API path too.
    let path: string;
    try { path = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response("Bad Request", { status: 400 }); }
    const isApi = path.startsWith("/api/");
    const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if ((isApi || isWrite) && req.headers.get("sec-fetch-site") === "cross-site") return new Response("Forbidden", { status: 403 });
    if (isWrite) {
      const origin = req.headers.get("origin");
      const sameOrigin = !!origin && origin.replace(/^https?:\/\//, "") === req.headers.get("host");
      if (origin && !sameOrigin && !allowedOrigins.includes(origin)) return new Response("Forbidden", { status: 403 });
    }
    // A CORS preflight carries no credential; the CORS middleware answers it and no route runs.
    if (isApi && req.method !== "OPTIONS") {
      const kind = credential();
      if (!kind) return unauthorized();
      if (kind === "owner") markOwnerRequest(req);
      if (isWrite) {
        // A cross-site form or no-cors fetch can send a text/plain body that the JSON routes still parse.
        const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (type !== "application/json") return new Response("Unsupported Media Type", { status: 415 });
      }
    }
    return fetchImpl(req, env);
  };
}
