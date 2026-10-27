import type { Finding } from "@tracer-sh/shared";
import { cn } from "@/lib/utils";
import { Inline, stripInline } from "../../lib/inline-markdown";
import type { CardData } from "../../lib/finding-card";

const PILL: Record<NonNullable<Finding["confidence"]>, string> = {
  confirmed: "bg-success-tint text-success",
  likely: "bg-warning-tint text-warning",
  unverified: "bg-secondary text-ink-2",
};

const VERDICT: Record<NonNullable<Finding["verdict"]>, { label: string; tint: string }> = {
  problem: { label: "Problem", tint: "bg-destructive/10 text-destructive" },
  no_problem: { label: "No problem", tint: "bg-success-tint text-success" },
  unclear: { label: "Unclear", tint: "bg-warning-tint text-warning" },
};

function Section({ label, compact, children }: { label: string; compact: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("mt-4", compact && "mt-3")}>
      <p className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">{label}</p>
      <div className={cn("mt-1", compact && "mt-0.5")}>{children}</div>
    </div>
  );
}

export function FindingCard({ card, revising = false, compact = false }: { card: CardData; revising?: boolean; compact?: boolean }) {
  const isCause = card.kind === "root_cause";
  const verdict = isCause && card.verdict ? VERDICT[card.verdict] : null;
  const label = card.kind === "summary" ? "Summary" : verdict ? verdict.label : "Finding";
  const body = "text-[15px]/[1.6] text-ink-2 [overflow-wrap:anywhere]";
  return (
    <section
      data-answer-card
      aria-label={label}
      className={cn(
        "rounded-[14px] border bg-card px-6 py-5 shadow-[0_1px_2px_rgb(0_0_0/0.05),0_8px_24px_rgb(0_0_0/0.08)] max-sm:px-4",
        compact && "px-4 py-3.5",
        revising && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        {card.kind === "summary" && <p className="text-xs font-semibold tracking-[0.08em] text-primary uppercase">Summary</p>}
        {verdict && <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", verdict.tint)}>{verdict.label}</span>}
        {isCause && card.confidence && <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", PILL[card.confidence])}>{card.confidence[0].toUpperCase() + card.confidence.slice(1)}{card.verdict === "problem" && " cause"}</span>}
        {revising && <span className="text-xs text-muted-foreground">Revising</span>}
      </div>
      <h3 className={cn("mt-1.5 text-xl/[1.25] font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]", compact && "text-base/[1.25]")}>
        {card.title ? stripInline(card.title) : stripInline(card.answer)}
      </h3>
      {card.title && card.answer && <p className={cn("mt-2", body, compact && "text-sm/[1.55]")}><Inline text={card.answer} highlight /></p>}
      {card.explanation.length > 0 && (
        <Section label={isCause ? "Why" : "Details"} compact={compact}>
          <ol className={cn("ml-5 list-decimal space-y-2", body, compact && "space-y-1.5 text-sm/[1.55]")}>
            {card.explanation.map((e, i) => (
              <li key={i} className="pl-1"><Inline text={e.statement} highlight /></li>
            ))}
          </ol>
        </Section>
      )}
      {card.action && <Section label="Action taken" compact={compact}><p className={cn(body, compact && "text-sm/[1.55]")}><Inline text={card.action} /></p></Section>}
      {card.unknown && (
        <p className={cn("mt-5 rounded-[10px] bg-secondary px-4 py-3 text-sm text-ink-2 [overflow-wrap:anywhere]", compact && "mt-4 px-3 py-2.5")}>
          <b className="font-semibold text-foreground">Unknown:</b> <Inline text={card.unknown} />
        </p>
      )}
    </section>
  );
}
