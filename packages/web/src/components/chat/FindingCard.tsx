import { Check } from "lucide-react";
import type { Finding } from "@tracer-sh/shared";
import { cn } from "@/lib/utils";
import { Markdown } from "../../lib/markdown";

const PILL: Record<NonNullable<Finding["confidence"]>, string> = {
  confirmed: "bg-success-tint text-success",
  likely: "bg-warning-tint text-warning",
  unverified: "bg-secondary text-ink-2",
};

export function FindingCard({ finding, compact = false }: { finding: Finding; compact?: boolean }) {
  const isCause = finding.kind === "root_cause";
  const confidence = finding.confidence ?? "unverified";
  const verified = !isCause || confidence === "confirmed";
  return (
    <section
      data-answer-card
      aria-label={isCause ? "Root cause" : "Summary"}
      className={cn(
        "rounded-[14px] border bg-card px-6 py-5 shadow-[0_1px_2px_rgb(0_0_0/0.05),0_8px_24px_rgb(0_0_0/0.08)] max-sm:px-4",
        compact && "px-4 py-3.5",
      )}
    >
      <div className="flex items-center gap-2.5">
        <p className={cn("text-xs font-semibold tracking-[0.08em] uppercase", isCause ? "text-destructive" : "text-primary")}>{isCause ? "Root cause" : "Summary"}</p>
        {isCause && (
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", PILL[confidence])}>{confidence}</span>
        )}
      </div>
      <h3 className={cn("mt-1.5 text-xl/[1.25] font-semibold tracking-tight text-foreground", compact && "text-base/[1.25]")}>{finding.headline}</h3>
      {finding.details && <Markdown text={finding.details} className={cn("mt-3 text-[15px]/[1.6] text-ink-2 [&_strong]:text-foreground", compact && "mt-2 text-sm/[1.55]")} />}
      {finding.points.length > 0 && (
        <ul className={cn("mt-4 space-y-2.5", compact && "mt-3 space-y-2")}>
          {finding.points.map((e, i) => (
            <li key={i} className="flex items-center gap-3 text-[15px] text-foreground">
              <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-full", verified ? "bg-success-tint text-success" : "bg-secondary text-muted-foreground")}>
                {verified ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
              </span>
              {e}
            </li>
          ))}
        </ul>
      )}
      {isCause && finding.toConfirm && (
        <p className={cn("mt-5 rounded-[10px] bg-secondary px-4 py-3 text-sm text-ink-2", compact && "mt-4 px-3 py-2.5")}>
          <b className="font-semibold text-foreground">To confirm:</b> {finding.toConfirm}
        </p>
      )}
    </section>
  );
}
