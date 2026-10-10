import type { SyncPhase, SyncSession } from "@tracer-sh/shared";

export type StepState = "done" | "current" | "todo";
export type Device = "computer" | "phone";

export const STEPS = ["Scan the code", "Allow on the computer", "Send data", "Save data"] as const;

const ACTIVE: Partial<Record<SyncPhase, number>> = { waiting: 0, approval: 1, transfer: 2, apply: 3 };

export const isSyncOver = (phase: SyncPhase): boolean => !(phase in ACTIVE);

/** Marks each step done, current or todo. A sync that ended badly leaves the step it had reached as current. */
export function stepStates(session: SyncSession): StepState[] {
  if (session.phase === "done") return STEPS.map(() => "done");
  const at = ACTIVE[session.phase] ?? ACTIVE[session.reached ?? "waiting"] ?? 0;
  return STEPS.map((_, i) => (i < at ? "done" : i === at ? "current" : "todo"));
}

/** "1:42" for the seconds left until `expiresAt`; never negative. */
export function countdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** "3 of 12 MB", or only the done part when the total is unknown. */
export function progressText(bytes: { done: number; total: number }): string {
  if (!bytes.total) return megabytes(bytes.done);
  const total = megabytes(bytes.total);
  const done = (bytes.done / 1024 / 1024).toFixed(bytes.total < 10 * 1024 * 1024 ? 1 : 0);
  return `${done} of ${total}`;
}

export function progressFraction(bytes?: { done: number; total: number }): number | null {
  return bytes?.total ? Math.min(1, bytes.done / bytes.total) : null;
}

const counts = (c: { applied: number; deleted: number }) => `${c.applied} changed, ${c.deleted} removed`;

/** The one sentence under the current step, for the device that renders it. Empty when the view shows buttons or a bar instead. */
export function stepMessage(session: SyncSession, device: Device): string {
  const other = device === "computer" ? session.phoneName || "The phone" : session.computerName || "the computer";
  switch (session.phase) {
    case "waiting":
      return device === "computer" ? "Scan the code with the iPhone Camera app." : "Contacting the computer.";
    case "approval":
      return device === "computer" ? `${other} asks to sync. Click Allow.` : "Now click Allow on your computer.";
    case "transfer":
      return device === "computer" ? "Sending data to the phone." : "Receiving data from the computer. Keep Tracer open.";
    case "apply":
      return device === "phone" ? "Saving on the phone. Keep Tracer open." : "The phone saves the data. Keep the phone's Tracer app open.";
    case "done": {
      const { computer, phone } = session.result ?? {};
      if (session.mode === "replace") return `Synced. The phone has a copy of the data of ${device === "phone" ? session.computerName || "the computer" : "this computer"}.`;
      return `Synced. Computer: ${computer ? counts(computer) : "no changes"}. Phone: ${phone ? counts(phone) : "no changes"}.`;
    }
    case "denied":
      return device === "computer" ? "You denied the request." : "The computer denied the request.";
    case "expired":
      return session.phoneName ? "Nobody allowed the sync in time." : "The code expired.";
    case "cancelled":
      return session.error?.message ?? "The sync was cancelled.";
    case "failed": {
      const { message, side } = session.error ?? { message: "The sync failed.", side: "computer" as const };
      return `Failed on the ${side}. ${message}${savedPart(session)}`;
    }
  }
}

/** A merge writes on the computer first; a later failure leaves that part saved. */
function savedPart(session: SyncSession): string {
  return session.mode === "merge" && session.result?.computer ? " The computer saved its part. Syncing again is safe." : "";
}

export function modeText(mode: SyncSession["mode"], device: Device): string {
  return mode === "replace"
    ? `First sync: the phone's data is replaced with a copy of ${device === "computer" ? "this" : "the"} computer's data.`
    : "Both devices keep the newest version of each item.";
}
