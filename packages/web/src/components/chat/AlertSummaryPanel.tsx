import { Fragment } from "react";
import type { UIMessage } from "ai";
import { CircleAlert, CircleCheck, CircleHelp, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { hasErrorOutput } from "../../lib/chat-utils";

const SEVERITY = {
  high: { label: "High", className: "bg-destructive-tint text-destructive" },
  medium: { label: "Medium", className: "bg-warning-tint text-warning" },
  low: { label: "Low", className: "bg-muted text-ink-2" },
} as const;

interface AlertSummary {
  severity: keyof typeof SEVERITY;
  tldr: string;
  rootCause?: string;
  policy?: string;
  started?: string;
  status?: string;
  issues?: Array<{ service?: string; endpoint?: string; errors?: string; userImpact?: string; journeyStep?: string }>;
  seenBefore?: string;
}

interface IssueStatus {
  issueId: string;
  status: string;
  reason?: string;
}

const STATUS: Record<string, { icon: LucideIcon; className: string }> = {
  stopped: { icon: CircleCheck, className: "text-success" },
  ongoing: { icon: CircleAlert, className: "text-warning" },
  recurring: { icon: CircleAlert, className: "text-warning" },
  unknown: { icon: CircleHelp, className: "text-muted-foreground" },
};

/** Input of the last successful call of a tool; a call the server rejected returns `{ error }`. */
function lastToolInput(messages: UIMessage[], type: string): Record<string, unknown> | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const parts = messages[m].parts;
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p] as { type: string; state?: string; input?: unknown; output?: unknown };
      const rejected = hasErrorOutput(part.output);
      if (part.type === type && part.state === "output-available" && !rejected && part.input && typeof part.input === "object") {
        return part.input as Record<string, unknown>;
      }
    }
  }
  return null;
}

export function alertSummaryOf(messages: UIMessage[]): { summary: AlertSummary; triage: IssueStatus[] } | null {
  const input = lastToolInput(messages, "tool-report_alert_summary");
  if (!input || typeof input.tldr !== "string" || !(String(input.severity) in SEVERITY)) return null;
  const triage = lastToolInput(messages, "tool-report_issue_status")?.issues;
  return { summary: input as unknown as AlertSummary, triage: Array.isArray(triage) ? (triage as IssueStatus[]) : [] };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function AlertSummaryPanel({ summary, triage }: { summary: AlertSummary; triage: IssueStatus[] }) {
  const severity = SEVERITY[summary.severity];
  const facts = ([
    ["Root cause", summary.rootCause, false],
    ["Policy", summary.policy, true],
    ["Started", summary.started, false],
    ["Status", summary.status && capitalize(summary.status), false],
    ["Seen before", summary.seenBefore && capitalize(summary.seenBefore), false],
  ] as Array<[string, string | undefined, boolean]>).filter(([, v]) => v);

  return (
    <section aria-label="Alert summary" className="rounded-lg border bg-card animate-in fade-in duration-300">
      <div className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <Badge className={cn("mt-0.5 rounded-md", severity.className)}>{severity.label}</Badge>
          <h2 className="text-base font-semibold text-pretty">{summary.tldr}</h2>
        </div>
        {facts.length > 0 && (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[7rem_1fr]">
            {facts.map(([label, value, mono]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground max-sm:mt-1 max-sm:text-xs">{label}</dt>
                <dd className={cn("min-w-0 [overflow-wrap:anywhere]", mono && "font-mono text-[13px]/[18px]")}>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {summary.issues && summary.issues.length > 0 && (
          <ul className="space-y-1.5" aria-label="Issues">
            {summary.issues.map((issue, i) => (
              <li key={i} className="text-sm/6 text-ink-2 [overflow-wrap:anywhere]">
                {[issue.endpoint, issue.service, issue.errors, issue.userImpact, issue.journeyStep].filter(Boolean).map((v, j) => (
                  <Fragment key={j}>
                    {j > 0 && <span aria-hidden="true">{"\u00a0· "}</span>}
                    {j === 0 ? <code className="font-mono text-[13px]/[18px] text-foreground">{v}</code> : <span>{v}</span>}
                  </Fragment>
                ))}
              </li>
            ))}
          </ul>
        )}
      </div>
      {triage.length > 0 && (
        <ul className="space-y-1.5 border-t px-5 py-3" aria-label="Triage">
          {triage.map((t) => {
            const { icon: Icon, className } = STATUS[t.status] ?? STATUS.unknown;
            return (
              <li key={t.issueId} className="flex items-start gap-2 text-[13px]/[18px] text-ink-2">
                <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />
                <span>
                  {capitalize(t.status)}
                  {t.reason && ` · ${t.reason}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
