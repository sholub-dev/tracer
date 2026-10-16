import type { UIMessage } from "ai";
import { isSteered } from "@tracer-sh/shared";

export interface ThreadRow {
  msg: UIMessage;
  /** Index of the message this row shows in the list that was passed in; pending messages count after it. */
  index: number;
  key: string;
  /** False for the pieces of a reply that steered messages cut apart, except the last piece. */
  last: boolean;
}

interface Placement {
  /** The step the server let the message land before: the number of step-start parts of the reply that come first. */
  anchor?: number;
  /** The length of the live reply when the message was sent; it holds until the server reports the step. */
  at?: number;
}

const placementOf = (m: UIMessage) => (m.metadata ?? {}) as Placement;

/** The saved or live steered message with the step the server reported. */
export function withAnchor(m: UIMessage, anchor: number | undefined): UIMessage {
  return anchor === undefined || placementOf(m).anchor === anchor ? m : { ...m, metadata: { ...(m.metadata as object | undefined), anchor } };
}

export const anchorOf = (m: UIMessage): number | undefined => placementOf(m).anchor;

function cutOf(m: UIMessage, parts: UIMessage["parts"]): number {
  const { anchor, at } = placementOf(m);
  if (typeof anchor === "number") {
    let seen = 0;
    const found = parts.findIndex((p) => p.type === "step-start" && seen++ === anchor);
    if (found !== -1) return found;
  }
  return typeof at === "number" ? Math.min(at, parts.length) : parts.length;
}

const shows = (parts: UIMessage["parts"]) => parts.some((p) => p.type !== "step-start");

/**
 * The thread as rows. A steered message follows the reply it shaped in the saved order, but it belongs inside that reply,
 * at the step the agent saw it: the reply is cut there and the message sits between the pieces.
 */
export function placeSteered(messages: UIMessage[], pending: UIMessage[]): ThreadRow[] {
  const saved = new Set(messages.map((m) => m.id));
  const all = [...messages, ...pending.filter((m) => !saved.has(m.id))];
  const rows: ThreadRow[] = [];
  const own = (msg: UIMessage, index: number): ThreadRow => ({ msg, index, key: msg.id || `msg-${index}`, last: true });
  for (let i = 0; i < all.length; i++) {
    const msg = all[i];
    let end = i + 1;
    while (msg.role === "assistant" && !isSteered(msg) && end < all.length && isSteered(all[end])) end++;
    if (end === i + 1) {
      rows.push(own(msg, i));
      continue;
    }
    const after = all.slice(i + 1, end).map((m, n) => ({ m, index: i + 1 + n, cut: cutOf(m, msg.parts) }));
    // Stable: messages cut at one place keep their send order.
    after.sort((a, b) => a.cut - b.cut);
    const pieces: Array<{ parts: UIMessage["parts"]; steered?: (typeof after)[number] }> = [];
    let from = 0;
    for (const s of after) {
      pieces.push({ parts: msg.parts.slice(from, s.cut), steered: s });
      from = s.cut;
    }
    pieces.push({ parts: msg.parts.slice(from) });
    const shown = pieces.filter((p) => shows(p.parts));
    const replyRows: ThreadRow[] = [];
    if (shown.length === 0) replyRows.push(own(msg, i));
    for (const p of pieces) {
      if (shown.length > 0 && shows(p.parts)) replyRows.push({ msg: { ...msg, parts: p.parts }, index: i, key: `${msg.id || `msg-${i}`}${replyRows.length ? `-${replyRows.length}` : ""}`, last: false });
      if (p.steered) replyRows.push({ ...own(p.steered.m, p.steered.index), last: true });
    }
    const lastPiece = replyRows.findLastIndex((r) => r.msg.role === "assistant");
    if (lastPiece !== -1) replyRows[lastPiece].last = true;
    rows.push(...replyRows);
    i = end - 1;
  }
  return rows;
}
