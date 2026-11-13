/** MCP result helpers for the tools of MCP-backed providers (GCP). */

/**
 * Unwraps an MCP tool result, which is { content: [{type:"text", text:"..."}], isError }.
 * `value` is the parsed JSON of the text, the text itself or the whole result; `text` is what to search for markers.
 */
export function extractMcpContent(result: unknown): { value: unknown; text: string } {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      const texts = (r.content as Array<{ type?: string; text?: string }>)
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (texts.length > 0) {
        const text = texts.join("\n").trim();
        try {
          return { value: JSON.parse(text), text };
        } catch {
          return { value: text, text };
        }
      }
    }
  }
  return { value: result, text: JSON.stringify(result) ?? "" };
}

/** The message of a failed call, or undefined when it succeeded. The MCP server reports API failures as a `{"error":{name,message,stack}}` text without isError. */
export function mcpFailure(result: unknown, { value, text }: { value: unknown; text: string }): string | undefined {
  const flagged = (result as { isError?: boolean } | null)?.isError === true;
  const err = value && typeof value === "object" && !Array.isArray(value) ? (value as { error?: unknown }).error : undefined;
  if (!flagged && !err) return undefined;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const message = (err as { message?: unknown }).message;
    return typeof message === "string" ? message : JSON.stringify(err);
  }
  return text;
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
