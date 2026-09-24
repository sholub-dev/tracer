import { parseCondition } from "@tracer-sh/shared";
import type { Threshold } from "../components/charts/ChartView";

/** Chart line for a condition like "> 50"; none for == and != */
export function parseThreshold(condition: string): Threshold | undefined {
  const c = parseCondition(condition);
  return c && c.op !== "==" && c.op !== "!=" ? { operator: c.op, value: c.threshold } : undefined;
}

/** Convert "X hours/minutes ago" to seconds */
export function sinceToSeconds(since: string): number {
  const m = since.match(/([\d.]+)\s*(minute|hour|day)/i);
  if (!m) return 3600;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("minute")) return n * 60;
  if (unit.startsWith("hour")) return n * 3600;
  return n * 86400;
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "never";
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function formatFrequency(seconds: number): string {
  const units: Array<[number, string]> = [[86400, "day"], [3600, "hour"], [60, "min"]];
  for (const [size, label] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return label === "min" ? `every ${n} min` : `every ${n} ${label}${n === 1 ? "" : "s"}`;
    }
  }
  return `every ${seconds}s`;
}

export function statusVariant(status: string): "error" | "warn" | "success" {
  if (status === "triggered") return "error";
  return status === "error" ? "warn" : "success";
}
