export type SyncMode = "merge" | "replace";

/** Steps run in this order; the rest end the sync. */
export type SyncPhase = "waiting" | "approval" | "transfer" | "apply" | "done" | "denied" | "expired" | "cancelled" | "failed";

export interface SyncCounts {
  applied: number;
  deleted: number;
}

/** The state of one sync. The computer owns it; both devices show it. */
export interface SyncSession {
  phase: SyncPhase;
  /** Unknown until the phone asks. */
  mode?: SyncMode;
  computerName: string;
  /** Unknown until the phone asks. */
  phoneName?: string;
  /** When the current wait for the other device ends. */
  expiresAt: number;
  /** Bytes of the data moving to the phone. `total` is 0 when unknown. */
  bytes?: { done: number; total: number };
  result?: { computer?: SyncCounts; phone?: SyncCounts };
  /** The step a sync that ended badly had reached. */
  reached?: Extract<SyncPhase, "waiting" | "approval" | "transfer" | "apply">;
  /** Why the sync failed, or who cancelled it. */
  error?: { message: string; side: "computer" | "phone" };
}
