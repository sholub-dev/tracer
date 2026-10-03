import { serverFetch } from "./server-fetch";

// EventSource's default wait before it reconnects.
const RECONNECT_MS = 3000;

export interface EventStreamHandlers {
  onEvent: (event: string, data: string) => void;
  /** `closed` is true when the stream gives up and does not reconnect. */
  onError: (closed: boolean) => void;
}

/** Feeds each event of a server-sent-events body to `onEvent` until the body ends or `signal` aborts. */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: EventStreamHandlers["onEvent"],
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) return;
    // A trailing "\r" waits for the next chunk: it can be the first half of "\r\n".
    const lines = (buffer + decoder.decode(value, { stream: true })).split(/\r\n|\n|\r(?!$)/);
    buffer = lines.pop()!;
    for (const line of lines) {
      if (signal?.aborted) return;
      if (line === "") {
        if (data.length > 0) onEvent(event || "message", data.join("\n"));
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let fieldValue = colon === -1 ? "" : line.slice(colon + 1);
      if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
      if (field === "event") event = fieldValue;
      else if (field === "data") data.push(fieldValue);
    }
  }
}

/**
 * A fetch-based EventSource. A dropped connection calls `onError(false)` and reconnects;
 * a response that is not an event stream calls `onError(true)` and stops. Returns the close function.
 */
export function openEventStream(url: string, { onEvent, onError }: EventStreamHandlers): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  void (async () => {
    while (!signal.aborted) {
      try {
        const res = await serverFetch(url, { headers: { Accept: "text/event-stream" }, cache: "no-store", signal });
        if (!res.ok || !res.body || !res.headers.get("content-type")?.startsWith("text/event-stream")) {
          controller.abort();
          onError(true);
          return;
        }
        await readEventStream(res.body, onEvent, signal);
      } catch { /* network error or close */ }
      if (signal.aborted) return;
      onError(false);
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
    }
  })();
  return () => controller.abort();
}
