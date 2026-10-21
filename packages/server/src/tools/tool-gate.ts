import { TOOL_NAMES } from "@tracer-sh/shared";

export const MAX_CONCURRENT_READS = 4;

/** Tools that change state: each runs alone, in call order. Every other tool is a read. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  ...Object.values(TOOL_NAMES),
  "report_finding",
  "report_issue_status",
  "report_alert_summary",
  "dismiss_alert",
  "set_timer",
  "add_jira_comment",
  "post_slack_message",
  "ack_nr_issue",
  "close_nr_issue",
  "create_memory",
  "update_memory",
  "delete_memory",
]);

/** A read that finished in the current step. */
export interface ReadResult {
  toolName: string;
  input: unknown;
  text: string;
}

interface Waiter {
  write: boolean;
  start: () => void;
}

/**
 * Per-run gate for the tool calls of one step, which the AI SDK starts all at once.
 * Reads share a limit; a write waits for running reads and blocks later calls until it ends.
 * Calls start in arrival order, so a write is never overtaken by a read that came after it.
 */
export function createToolGate(maxReads = MAX_CONCURRENT_READS) {
  const queue: Waiter[] = [];
  let reads = 0;
  let writing = false;
  let finished: ReadResult[] = [];

  const pump = () => {
    for (let head = queue[0]; head; head = queue[0]) {
      if (head.write ? reads > 0 || writing : writing || reads >= maxReads) return;
      queue.shift();
      if (head.write) writing = true;
      else reads++;
      head.start();
    }
  };

  const acquire = (write: boolean, signal?: AbortSignal): Promise<() => void> =>
    new Promise((resolve, reject) => {
      const waiter: Waiter = {
        write,
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(() => {
            if (write) writing = false;
            else reads--;
            pump();
          });
        },
      };
      const onAbort = () => {
        const i = queue.indexOf(waiter);
        if (i === -1) return;
        queue.splice(i, 1);
        reject(signal?.reason ?? new Error("Aborted"));
        pump();
      };
      if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
      pump();
    });

  /** The result as the model reads it: the tool's own model output when it has one, else the JSON of the output. */
  const readText = async (def: unknown, input: unknown, output: unknown, toolCallId: string | undefined): Promise<string> => {
    try {
      const toModelOutput = (def as { toModelOutput?: (a: unknown) => unknown } | null)?.toModelOutput;
      const shaped = toModelOutput ? await toModelOutput.call(def, { toolCallId, input, output }) : output;
      const value = (shaped as { type?: string; value?: unknown } | null)?.value;
      if (typeof value === "string") return value;
      return JSON.stringify(shaped !== null && typeof shaped === "object" && "value" in shaped ? value : shaped) ?? "";
    } catch {
      return "";
    }
  };

  /** Returns the tools with each `execute` held by the gate; tool properties other than `execute` stay as they are. */
  function gateTools<T extends Record<string, unknown>>(tools: T): T {
    const gated: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(tools)) {
      const execute = (def as { execute?: (...args: unknown[]) => unknown } | null)?.execute;
      if (typeof execute !== "function") {
        gated[name] = def;
        continue;
      }
      const write = WRITE_TOOLS.has(name);
      gated[name] = {
        ...(def as object),
        execute: async (input: unknown, options?: { abortSignal?: AbortSignal; toolCallId?: string }) => {
          const release = await acquire(write, options?.abortSignal);
          try {
            const output = await execute.call(def, input, options);
            if (!write) finished.push({ toolName: name, input, text: await readText(def, input, output, options?.toolCallId) });
            return output;
          } finally {
            release();
          }
        },
      };
    }
    return gated as T;
  }

  // A write waits for the reads before it, so these have finished when a review in the same step reads them.
  return Object.assign(gateTools, {
    /** Results of the reads that finished in the current step. */
    stepReads: (): ReadResult[] => [...finished],
    /** Call before each step; the earlier steps are already in the step's messages. */
    startStep: () => { finished = []; },
  });
}
