type Callback = (part: Record<string, unknown>) => void;

/**
 * Minimal pub/sub with ordered replay buffer.
 * Late subscribers get full replay of buffered parts, then live events.
 */
export class StreamBroadcaster {
  private buffer: Record<string, unknown>[] = [];
  private subscribers = new Set<Callback>();
  private doneCallbacks = new Set<() => void>();
  private _done = false;

  get done(): boolean {
    return this._done;
  }

  emit(part: Record<string, unknown>): void {
    if (this._done) return;
    this.bufferPart(part);
    for (const cb of this.subscribers) {
      try { cb(part); } catch (err) { console.warn("[StreamBroadcaster] subscriber error:", err); }
    }
  }

  // Consecutive deltas of one block are merged so replay is a few parts, not thousands.
  // The last entry is replaced, never mutated: it may already be held by a subscriber.
  private bufferPart(part: Record<string, unknown>): void {
    const last = this.buffer[this.buffer.length - 1];
    if (
      last
      && (part.type === "text-delta" || part.type === "reasoning-delta")
      && last.type === part.type
      && last.id === part.id
      && typeof last.delta === "string"
      && typeof part.delta === "string"
    ) {
      this.buffer[this.buffer.length - 1] = { ...last, delta: last.delta + part.delta };
      return;
    }
    this.buffer.push(part);
  }

  /** Subscribe to parts. Replays buffer immediately, then delivers live events. Returns unsubscribe fn. */
  subscribe(cb: Callback): () => void {
    // Replay buffered parts
    for (const part of this.buffer) {
      try { cb(part); } catch (err) { console.warn("[StreamBroadcaster] replay error:", err); }
    }

    if (this._done) {
      // Stream already finished — nothing more to deliver
      return () => {};
    }

    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }

  /** Register a callback for when the stream finishes. Returns unregister fn. */
  onDone(cb: () => void): () => void {
    if (this._done) {
      // Already done — fire immediately
      try { cb(); } catch (err) { console.warn("[StreamBroadcaster] onDone immediate error:", err); }
      return () => {};
    }
    this.doneCallbacks.add(cb);
    return () => { this.doneCallbacks.delete(cb); };
  }

  /** Mark the stream as finished. Fires done callbacks and clears subscribers. */
  finish(): void {
    if (this._done) return;
    this._done = true;
    for (const cb of this.doneCallbacks) {
      try { cb(); } catch (err) { console.warn("[StreamBroadcaster] done callback error:", err); }
    }
    this.subscribers.clear();
    this.doneCallbacks.clear();
  }
}
