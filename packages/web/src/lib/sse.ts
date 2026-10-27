/** Feeds each event of a server-sent-events body to `onEvent` until the body ends or `signal` aborts. */
export async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string) => void,
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
