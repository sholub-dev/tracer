import { readEventStream } from "./sse";
import { serverFetch } from "./server-fetch";

/**
 * EventSource over `serverFetch`: the browser's EventSource cannot send the Authorization header.
 * It does not reconnect; a closed stream reports an error and the caller opens a new one.
 */
export class FetchEventSource extends EventTarget {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readyState = 0;
  private readonly abort = new AbortController();

  constructor(url: string) {
    super();
    void this.run(url);
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.abort.abort();
  }

  private async run(url: string): Promise<void> {
    const { signal } = this.abort;
    try {
      const res = await serverFetch(url, { headers: { Accept: "text/event-stream" }, cache: "no-store", signal });
      if (res.ok && res.body && !signal.aborted) {
        this.readyState = this.OPEN;
        this.dispatchEvent(new Event("open"));
        await readEventStream(res.body, (event, data) => this.dispatchEvent(new MessageEvent(event, { data })), signal);
      }
    } catch { /* reported as an error event below */ }
    if (signal.aborted) return;
    this.readyState = this.CLOSED;
    this.dispatchEvent(new Event("error"));
  }
}
