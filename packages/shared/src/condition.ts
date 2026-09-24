export type ConditionOp = ">" | ">=" | "<" | "<=" | "==" | "!=";

export interface Condition {
  op: ConditionOp;
  threshold: number;
}

const CONDITION_RE = /^\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/;

export function parseCondition(str: string): Condition | null {
  const m = CONDITION_RE.exec(str);
  if (!m) return null;
  return { op: m[1] as ConditionOp, threshold: Number(m[2]) };
}
