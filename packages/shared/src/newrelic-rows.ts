import { dropFlattenedResultCopies, isPlainObject } from "./query-utils.js";

const APDEX_KEYS = ["count", "f", "s", "score", "t"];

function isApdex(o: Record<string, unknown>): boolean {
  const keys = Object.keys(o);
  return keys.length === APDEX_KEYS.length && APDEX_KEYS.every((k) => k in o);
}

// NR's apdex object leads with count, but score is its value; a bucket with no transactions has no score.
function orderApdex(o: Record<string, unknown>): Record<string, unknown> {
  const { score, ...rest } = o;
  return { score: o.count === 0 ? null : score, ...rest };
}

/** The one place for New Relic result-shape rules, shared by the server and by saved results in the web. */
export function normalizeNewRelicRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  const base = dropFlattenedResultCopies(rows);
  let changed = false;
  const out = base.map((row) => {
    let next: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(row)) {
      if (!isPlainObject(v) || !isApdex(v)) continue;
      const ordered = orderApdex(v);
      if (Object.keys(v)[0] === "score" && ordered.score === v.score) continue;
      next ??= { ...row };
      next[k] = ordered;
    }
    if (next) changed = true;
    return (next ?? row) as T;
  });
  return changed ? out : base;
}
