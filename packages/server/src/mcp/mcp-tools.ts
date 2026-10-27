/**
 * MCP result helpers shared by MCP-backed provider direct tools (e.g. GCP).
 */

/**
 * Extract displayable content from an MCP tool result.
 * MCP tools return { content: [{type:"text", text:"..."}], isError: boolean }.
 * This unwraps the envelope so UI can render plain text or structured JSON.
 */
export function extractMcpContent(result: unknown): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const texts = (r.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (texts.length > 0) {
        const combined = texts.join("\n").trim();
        try {
          return JSON.parse(combined);
        } catch {
          return combined;
        }
      }
    }
  }
  return result;
}

/** Detect GCP server-side truncation markers in MCP results. */
export function detectTruncation(normalized: unknown): boolean {
  const str = typeof normalized === "string"
    ? normalized
    : JSON.stringify(normalized);
  return str.includes("truncated due to") && str.includes("character limit");
}

/** Detect transport-level errors that indicate the MCP subprocess has died. */
export function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("transport") ||
    msg.includes("disconnected") ||
    msg.includes("econnreset") ||
    msg.includes("epipe") ||
    msg.includes("channel closed") ||
    msg.includes("process exited") ||
    msg.includes("not connected") ||
    msg.includes("econnrefused")
  );
}
