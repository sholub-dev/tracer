import { isPlainObject, parseCondition, type Condition, type ConditionOp } from "@tracer-sh/shared";
import { isNumericValue } from "../providers/posthog/posthog-formatter.js";

export { parseCondition, type Condition, type ConditionOp };

export interface Group {
  key: string;
  count: number;
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
  return { key, count: count == null ? 0 : Number(count) };
}

/** Null when an object column holds no main value and nothing else is a number (an apdex window with no
 * traffic): that is no data, not a value of 0. A plain null cell stays 0, as an empty count is. */
function newRelicGroup(row: Record<string, unknown>): Group | null {
  const hasFacet = "facet" in row;
  const facetValues = new Set(hasFacet ? [row.facet].flat() : []);
  const entries = Object.entries(row).filter(([k]) => k !== "facet");
  // An object column (apdex, percentile) counts as its first member, its main value; the provider orders it.
  const main = (v: unknown): unknown => (isPlainObject(v) ? main(Object.values(v)[0]) : v);
  const objects = entries.filter(([, v]) => isPlainObject(v)).map(([k, v]): [string, unknown] => [k, main(v)]);
  // Top-level cells come first, so monitors written before object columns were read keep their value.
  const numeric = [...entries.filter(([, v]) => !isPlainObject(v)), ...objects].filter(([, v]) => typeof v === "number");
  if (numeric.length === 0 && objects.some(([, v]) => v == null)) return null;
  // NR repeats the facet attribute by name; skip it unless it is the only number left.
  const count = (numeric.find(([, v]) => !facetValues.has(v)) ?? numeric[0])?.[1] as number | undefined;
  return { key: hasFacet ? facetKey(row.facet) : "", count: count ?? 0 };
}

export function extractGroups(result: unknown, provider = "newrelic"): Group[] {
  return rowObjects(result).map(provider === "posthog" ? posthogGroup : newRelicGroup).filter((g): g is Group => g !== null);
}

export function sumGroups(groups: Group[]): number {
  return groups.reduce((s, g) => s + g.count, 0);
}
