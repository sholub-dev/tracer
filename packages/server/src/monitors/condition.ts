import { parseCondition, type Condition, type ConditionOp } from "@tracer-sh/shared";
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

function newRelicGroup(row: Record<string, unknown>): Group {
  const hasFacet = "facet" in row;
  const facetValues = new Set(hasFacet ? [row.facet].flat() : []);
  const numeric = Object.entries(row).filter(([k, v]) => k !== "facet" && typeof v === "number");
  // NR repeats the facet attribute by name; skip it unless it is the only number left.
  const count = (numeric.find(([, v]) => !facetValues.has(v)) ?? numeric[0])?.[1] as number | undefined;
  return { key: hasFacet ? facetKey(row.facet) : "", count: count ?? 0 };
}

export function extractGroups(result: unknown, provider = "newrelic"): Group[] {
  return rowObjects(result).map(provider === "posthog" ? posthogGroup : newRelicGroup);
}

export function sumGroups(groups: Group[]): number {
  return groups.reduce((s, g) => s + g.count, 0);
}
