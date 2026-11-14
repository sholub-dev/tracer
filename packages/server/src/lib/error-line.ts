const BODY_FIELD = /body|headers|^data$/i;
const MAX_OBJECT_CHARS = 300;

/**
 * An error for the log. An LLM or API call error also holds the request body and the response text, so it gives its message and HTTP status only.
 * Any other Error keeps its stack. A plain object gives its message, or its fields without the body ones.
 */
export function errorLine(err: unknown): string {
  if (err === null || typeof err !== "object") return String(err);
  const e = err as { statusCode?: unknown; status?: unknown; message?: unknown; stack?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : e.status;
  const withStatus = (message: string) => (typeof status === "number" ? `${message} (status ${status})` : message);
  if (err instanceof Error) {
    const apiCall = typeof status === "number" || Object.keys(err).some((k) => /^(request|response)/i.test(k));
    return apiCall || typeof e.stack !== "string" ? withStatus(err.message) : e.stack;
  }
  if (typeof e.message === "string") return withStatus(e.message);
  try {
    const json = JSON.stringify(err, (key, value) => (BODY_FIELD.test(key) ? undefined : value)) ?? String(err);
    return json.length > MAX_OBJECT_CHARS ? `${json.slice(0, MAX_OBJECT_CHARS)}…` : json;
  } catch {
    return String(err);
  }
}
