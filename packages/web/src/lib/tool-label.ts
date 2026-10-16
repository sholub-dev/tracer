import { isPlainObject } from "@tracer-sh/shared";

/** The one-line summary of a small tool call; `spec` carries its done and error wording. */
export function smallToolLabel(
  part: { type: string; input?: Record<string, unknown>; output?: unknown },
  spec: { done: string; errorLabel: string },
): string {
  const output = isPlainObject(part.output) ? part.output : {};
  if ("error" in output) return `${spec.errorLabel}: ${String(output.error)}`;
  if ("cancelled" in output) return "Follow-up timer cancelled";
  const note = typeof part.input?.note === "string" && part.input.note ? `: ${part.input.note}` : "";
  if (typeof output.dueAt === "string") return `${spec.done} for ${output.dueAt}${note}`;
  if (part.type === "tool-report_issue_status" && Array.isArray(part.input?.issues)) {
    const statuses = [...new Set((part.input.issues as Array<{ status?: string }>).map((i) => i.status).filter(Boolean))];
    if (statuses.length) return `${spec.done}: ${statuses.join(", ")}`;
  }
  return spec.done;
}
