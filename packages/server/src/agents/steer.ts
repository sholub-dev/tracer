import type { UIMessage } from "ai";
import { getCurrentTimeText } from "../lib/current-context.js";
import { stampSentTime } from "../llm/prompt-cache.js";
import type { Context } from "../trpc/context.js";

/** User messages sent while a run is active: `pending` waits for the next step, `steered` is already in the run. What is still pending when the run ends is dropped; the client sends it again. */
export interface SteerState {
  pending: UIMessage[];
  steered: UIMessage[];
}

export const newSteerState = (): SteerState => ({ pending: [], steered: [] });

/** Moves the waiting messages into the run and returns them. `anchor` is the step they land before; it is saved with them so every view puts them at the same place in the reply. */
export function drainSteer(state: SteerState, anchor: number): UIMessage[] {
  const drained = state.pending.splice(0);
  // In place: `steerChat` finds out by identity whether a step took its message.
  for (const m of drained) m.metadata = { ...(m.metadata as object | undefined), anchor };
  state.steered.push(...drained);
  return drained;
}

/** Queues a message for the active run of a session; false when no run is active. */
export async function steerChat(context: Context, sessionId: string, message: UIMessage): Promise<boolean> {
  const active = context.activeStreams.get(sessionId);
  if (!active) return false;
  // Queued before any wait, so messages sent in quick succession keep their order.
  active.steer.pending.push(message);
  const time = await getCurrentTimeText(context.db);
  const at = active.steer.pending.indexOf(message);
  // A step can read the message while the time is read; the run can end too.
  if (at === -1) return active.steer.steered.includes(message);
  [active.steer.pending[at]] = stampSentTime([message], time);
  return true;
}
