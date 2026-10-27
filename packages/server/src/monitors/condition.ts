import { isPlainObject, mainMemberKey, parseCondition, type Condition, type ConditionOp } from "@tracer-sh/shared";
import { isNumericValue } from "../providers/posthog/posthog-formatter.js";

export { parseCondition, type Condition, type ConditionOp };

export interface Group {
  key: string;
  count: number;
  /** Summing this group with its siblings is meaningful (a count), not (an average, an apdex score). */
  additive: boolean;
}

// NRQL aggregates whose per-facet values do not add up to a total; any other column name is treated as a sum.
const NON_ADDITIVE_FUNCTIONS = ["average", "median", "min", "max", "latest", "earliest", "stddev", "percentage", "percentile", "apdex"];

function isAdditiveColumn(name: string): boolean {
  return !NON_ADDITIVE_FUNCTIONS.some((fn) => name === fn || name.startsWith(`${fn}.`));
}


export function evaluateCondition(condition: Condition, value: number): boolean {
  switch (condition.op) {
    case ">": return value > condition.threshold;
    case ">=": return value >= condition.threshold;
    case "<": return value < condition.threshold;
    case "<=": return value <= condition.threshold;
    case "==": return value === condition.threshold;
    case "!=": return value !== condition.threshold;
  }
}

function facetKey(facet: unknown): string {
  return Array.isArray(facet) ? facet.map(String).join(", ") : String(facet);
}

function rowObjects(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result)) return [];
  return result.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

/** HogQL rows: count = first numeric column, key = the other (GROUP BY) values joined. */
function posthogGroup(row: Record<string, unknown>): Group {
  const values = Object.values(row);
  const count = values.find(isNumericValue);
  const key = values.filter((v) => !isNumericValue(v)).map((v) => (v == null ? "(none)" : String(v))).join(", ");
  return { key, count: count == null ? 0 : Number(count), additive: true };
}

/** Null when an object column holds no main value and nothing else is a number (an apdex window with no
 * traffic): that is no data, not a value of 0. A plain null cell stays 0, as an empty count is. */
function newRelicGroup(row: Record<string, unknown>): Group | null {
  const hasFacet = "facet" in row;
  const facetValues = new Set(hasFacet ? [row.facet].flat() : []);
  const entries = Object.entries(row).filter(([k]) => k !== "facet");
  // An object column (apdex, percentile) counts as its main member; the provider orders apdex with the score first.
  const main = (v: unknown): unknown => {
    if (!isPlainObject(v)) return v;
    const key = mainMemberKey(v);
    return key === undefined ? undefined : main(v[key]);
  };
  const objects = entries.filter(([, v]) => isPlainObject(v)).map(([k, v]): [string, unknown] => [k, main(v)]);
  // Top-level cells come first, so monitors written before object columns were read keep their value.
  const flat = entries.filter(([, v]) => !isPlainObject(v));
  const numeric = [...flat, ...objects].filter(([, v]) => typeof v === "number");
  if (numeric.length === 0 && objects.some(([, v]) => v == null)) return null;
  // NR repeats the facet attribute by name; skip it unless it is the only number left.
  const picked = numeric.find(([, v]) => !facetValues.has(v)) ?? numeric[0];
  const additive = !picked || (flat.includes(picked as [string, unknown]) && isAdditiveColumn(picked[0]));
  return { key: hasFacet ? facetKey(row.facet) : "", count: (picked?.[1] as number | undefined) ?? 0, additive };
}

export function extractGroups(result: unknown, provider = "newrelic"): Group[] {
  return rowObjects(result).map(provider === "posthog" ? posthogGroup : newRelicGroup).filter((g): g is Group => g !== null);
}

/** Rows came back but none holds a value: no data, so nothing to compare. */
export function isNoData(result: unknown, groups: Group[]): boolean {
  return groups.length === 0 && rowObjects(result).length > 0;
}

export function sumGroups(groups: Group[]): number {
  return groups.reduce((s, g) => s + g.count, 0);
}

export interface Evaluation {
  fires: boolean;
  /** The compared value: the sum, or the worst firing group (the worst group overall when none fires). */
  value: number;
  /** The groups that meet the condition; empty when the sum meets it with no rows. */
  groups: Group[];
}

/** Additive groups are summed and judged once; otherwise each group is judged on its own, because a sum of averages means nothing. */
export function evaluateGroups(condition: Condition, groups: Group[]): Evaluation {
  if (groups.length <= 1 || groups.every((g) => g.additive)) {
    const value = sumGroups(groups);
    return { fires: evaluateCondition(condition, value), value, groups };
  }
  const firing = groups.filter((g) => evaluateCondition(condition, g.count));
  const pool = firing.length > 0 ? firing : groups;
  const pick = (better: (a: number, b: number) => boolean) => pool.reduce((w, g) => (better(g.count, w.count) ? g : w)).count;
  const value = condition.op === ">" || condition.op === ">=" ? pick((a, b) => a > b)
    : condition.op === "<" || condition.op === "<=" ? pick((a, b) => a < b)
    : pool[0].count;
  return { fires: firing.length > 0, value, groups: firing };
}
