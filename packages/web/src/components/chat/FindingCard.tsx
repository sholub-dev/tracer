import { Check } from "lucide-react";
import type { Finding } from "@tracer-sh/shared";
import { cn } from "@/lib/utils";
import { Markdown } from "../../lib/markdown";
import { Inline, stripInline } from "../../lib/inline-markdown";
import { flashStep } from "./ToolParts";

type QueryRef = { title: string; toolCallId: string };

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

const LIST_ITEM = /^\s*(?:([-*•])|\d+[.)])\s+(.*)$/;

type Block = { kind: "p" | "ul" | "ol"; lines: string[] };

// Paragraphs and "- " or "1. " lists; everything inside a line is inline text only.
function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) { out.push({ kind: "p", lines: [] }); continue; }
    const m = line.match(LIST_ITEM);
    const kind = m ? (m[1] ? "ul" : "ol") : "p";
    const last = out.at(-1);
    if (last?.kind === kind && (kind !== "p" || last.lines.length)) last.lines.push(m ? m[2] : line.trim());
    else out.push({ kind, lines: [m ? m[2] : line.trim()] });
  }
  return out.filter((b) => b.lines.length);
}

function Body({ text, compact }: { text: string; compact: boolean }) {
  return (
    <div className={cn("space-y-2 text-[15px]/[1.6] text-ink-2 [overflow-wrap:anywhere]", compact && "text-sm/[1.55]")}>
      {blocks(text).map((b, i) => {
        if (b.kind === "p") return <p key={i}><Inline text={b.lines.join(" ")} /></p>;
        const List = b.kind;
        return (
          <List key={i} className={cn("ml-5 space-y-1", b.kind === "ul" ? "list-disc" : "list-decimal")}>
            {b.lines.map((l, j) => <li key={j} className="pl-1"><Inline text={l} /></li>)}
          </List>
        );
      })}
    </div>
  );
}

function Checks({ items, verified, compact }: { items: { fact: string; toolCallId?: string; title?: string }[]; verified: boolean; compact: boolean }) {
  return (
    <ul className={cn("space-y-2.5", compact && "space-y-2")}>
      {items.map(({ fact, toolCallId, title }, i) => (
        <li key={i} className="flex items-start gap-3 text-[15px] text-foreground">
          <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full", verified ? "bg-success-tint text-success" : "bg-secondary text-muted-foreground")}>
            {verified ? <Check className="size-3" strokeWidth={3} aria-hidden="true" /> : <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
          </span>
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <Inline text={fact} />
            {toolCallId && (
              <button
                type="button"
                onClick={() => flashStep(toolCallId)}
                title={title}
                className="ml-2 inline-block max-w-[16rem] truncate rounded-full bg-secondary px-2 py-0.5 align-middle text-[11px] font-medium text-ink-2 hover:text-foreground"
              >
                {title}
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function FindingCard({ finding, compact = false, queries = [] }: { finding: Finding; compact?: boolean; queries?: QueryRef[] }) {
  const link = (title?: string) => {
    const q = title && queries.find((r) => r.title.toLowerCase() === title.trim().toLowerCase());
    return q ? { toolCallId: q.toolCallId, title: q.title } : {};
  };
  const isCause = finding.kind === "root_cause";
  const confidence = finding.confidence ?? "unverified";
  const verdict = isCause && finding.verdict ? VERDICT[finding.verdict] : null;
  const label = !isCause ? "Summary" : verdict ? verdict.label : "Finding";
  return (
    <section
      data-answer-card
      aria-label={label}
      className={cn(
        "rounded-[14px] border bg-card px-6 py-5 shadow-[0_1px_2px_rgb(0_0_0/0.05),0_8px_24px_rgb(0_0_0/0.08)] max-sm:px-4",
        compact && "px-4 py-3.5",
      )}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        {verdict ? (
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", verdict.tint)}>{verdict.label}</span>
        ) : (
          <p className={cn("text-xs font-semibold tracking-[0.08em] uppercase", isCause ? "text-destructive" : "text-primary")}>{label}</p>
        )}
        {isCause && <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", PILL[confidence])}>{confidence}</span>}
      </div>
      <h3 className={cn("mt-1.5 text-xl/[1.25] font-semibold tracking-tight text-foreground", compact && "text-base/[1.25]")}>{stripInline(finding.headline)}</h3>
      {isCause ? (
        <>
          {finding.happened && <Section label="What happened" compact={compact}><Body text={finding.happened} compact={compact} /></Section>}
          {finding.cause && <Section label="Why" compact={compact}><Body text={finding.cause} compact={compact} /></Section>}
          {finding.evidence && finding.evidence.length > 0 && (
            <Section label="Evidence" compact={compact}>
              <Checks items={finding.evidence.map((e) => ({ fact: e.fact, ...link(e.query) }))} verified={confidence === "confirmed"} compact={compact} />
            </Section>
          )}
          {finding.impact && <Section label="Impact" compact={compact}><Body text={finding.impact} compact={compact} /></Section>}
          {finding.action && <Section label="Action taken" compact={compact}><Body text={finding.action} compact={compact} /></Section>}
          {finding.toConfirm && (
            <p className={cn("mt-5 rounded-[10px] bg-secondary px-4 py-3 text-sm text-ink-2 [overflow-wrap:anywhere]", compact && "mt-4 px-3 py-2.5")}>
              <b className="font-semibold text-foreground">To confirm:</b> <Inline text={finding.toConfirm} />
            </p>
          )}
        </>
      ) : (
        <>
          {finding.details && <Markdown text={finding.details} className={cn("mt-3 text-[15px]/[1.6] text-ink-2 [&_strong]:text-foreground", compact && "mt-2 text-sm/[1.55]")} />}
          {finding.points && finding.points.length > 0 && (
            <div className={cn("mt-4", compact && "mt-3")}>
              <Checks items={finding.points.map((fact) => ({ fact }))} verified compact={compact} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
