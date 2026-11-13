import React from "react";
import type { UIMessage } from "ai";
import { Download, FileText } from "lucide-react";
import { ANALYSIS_MARKER, findAnalysisMarker, findingSources } from "@tracer-sh/shared";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Markdown, ResultLookupProvider } from "../../lib/markdown";
import type { AskState } from "../../lib/ask-card";
import { AskCard } from "./AskCard";
import { FindingCard } from "./FindingCard";
import { ReasoningBlock } from "./ReasoningBlock";
import { OtherToolPart, ProviderStep, ResultCard, isAskPart, isHiddenPart, isProviderTool, resultLookup, type ToolPart } from "./ToolParts";
import { latestCard, matchSources } from "../../lib/finding-card";
import { ANSWER_PROSE, ANSWER_PROSE_COMPACT } from "./prose";

type Part = UIMessage["parts"][number];
type FilePartLike = { type: "file"; mediaType?: string; url: string; filename?: string };

export function FileAttachment({ part, className }: { part: FilePartLike; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const isImage = part.mediaType?.startsWith("image/");
  const label = part.filename ?? part.mediaType ?? "attachment";
  return (
    <>
      {isImage ? (
        <button type="button" onClick={() => setOpen(true)} className={cn("block cursor-zoom-in rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)} aria-label={`Open ${label}`}>
          <img src={part.url} alt={label} className="max-h-64 max-w-full rounded-md border" />
        </button>
      ) : (
        <Button variant="outline" size="sm" className={cn("max-w-full", className)} onClick={() => setOpen(true)}>
          <FileText />
          <span className="truncate">{label}</span>
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex h-[85svh] max-w-[min(64rem,calc(100%-2rem))] flex-col gap-3 sm:max-w-[min(64rem,calc(100%-2rem))]">
          <DialogHeader className="flex-row items-center gap-3 pr-8">
            <DialogTitle className="min-w-0 flex-1 truncate">{label}</DialogTitle>
            <DialogDescription className="sr-only">Attachment preview</DialogDescription>
            <Button variant="outline" size="sm" asChild>
              <a href={part.url} download={part.filename ?? "attachment"}>
                <Download />
                Download
              </a>
            </Button>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {isImage ? (
              <img src={part.url} alt={label} className="max-h-full max-w-full object-contain" />
            ) : (
              <iframe src={part.url} sandbox={part.url.startsWith("data:application/pdf") ? undefined : ""} title={label} className="size-full rounded-md border bg-card" />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AnswerText({ text, isAnimating, compact }: { text: string; isAnimating: boolean; compact: boolean }) {
  if (!text.trim()) return null;
  return <Markdown text={text} isAnimating={isAnimating} className={compact ? ANSWER_PROSE_COMPACT : ANSWER_PROSE} />;
}

const CLOSED: AskState = { status: "closed" };

// The AI SDK hands the first render of a reply its live message and later mutates its tool parts in place. A copy keeps
// the state this render saw, so a memoized tool view does not mistake the mutated part for an unchanged one.
const snapshot = (part: Part) => ({ ...part }) as ToolPart;

interface Props {
  parts: UIMessage["parts"];
  isAnimating: boolean;
  compact?: boolean;
  /** State of the reply's question card; it depends on the messages after the reply, so the thread passes it in. */
  ask?: AskState;
  onAsk?: (label: string) => void;
}

const sameAsk = (a?: AskState, b?: AskState) => a?.status === b?.status && (a as { chosen?: number | null } | undefined)?.chosen === (b as { chosen?: number | null } | undefined)?.chosen;

interface Entry {
  key: string;
  node: React.ReactNode;
  /** A step joins the run of steps around it in one list; text, files and the card stand on their own. */
  step?: boolean;
}

// A group is keyed by its first part and only ever grows at its end, so a part that arrives later never changes what rendered before it.
function flow(entries: Entry[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let group: Entry[] = [];
  const flush = () => {
    if (group.length) out.push(<ol key={`g${group[0].key}`} className="space-y-3">{group.map((e) => e.node)}</ol>);
    group = [];
  };
  for (const entry of entries) {
    if (entry.step) group.push(entry);
    else {
      flush();
      out.push(entry.node);
    }
  }
  flush();
  return out;
}

/** One reply, rendered in the order its parts arrive: text, steps and the card each stay where they appeared. */
export const MessageParts = React.memo(
  function MessageParts({ parts, isAnimating, compact = false, ask = CLOSED, onAsk }: Props) {
    if (parts.length === 0 && !isAnimating) {
      return <p className="text-sm text-muted-foreground">Interrupted before a reply.</p>;
    }

    const marker = findAnalysisMarker(parts);
    const cardIdx = parts.findIndex((p) => p.type === "tool-report_finding");
    const asked = parts.findLast((p) => isAskPart(p.type)) as ToolPart | undefined;
    const live = latestCard(parts, isAnimating);
    const stepParts = parts.filter((p) => isProviderTool(p.type)) as ToolPart[];
    // Sources show once the card has finished streaming, so the list does not grow while the card does.
    const streamingCard = parts.some((p) => p.type === "tool-report_finding" && (p as ToolPart).state === "input-streaming");
    const sources = live && !streamingCard ? findingSources(live.card) : [];
    const matched = matchSources(sources, stepParts);
    const evidence = sources.length > 0 && (
      <section aria-label="Evidence" className="space-y-3">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Evidence</p>
        <ol className="space-y-3">
          {sources.map((title, i) => {
            const part = matched[i];
            return (
              <li key={title.toLowerCase()}>
                {part ? <ResultCard part={part} /> : <p className="rounded-xl border bg-card p-4 text-sm font-medium text-foreground shadow-sm [overflow-wrap:anywhere]">{title}</p>}
              </li>
            );
          })}
        </ol>
      </section>
    );

    const before: Entry[] = [];
    const inside: Entry[] = [];
    let target = before;
    const text = (key: string, value: string) => ({ key, node: <AnswerText key={key} text={value} isAnimating={isAnimating} compact={compact} /> });
    parts.forEach((part, i) => {
      const key = `${i}`;
      if (marker && i === marker.partIdx) {
        if (marker.kind === "text" && part.type === "text") {
          before.push(text(key, part.text.slice(0, marker.charIdx)));
          inside.push(text(`${key}-after`, part.text.slice(marker.charIdx + ANALYSIS_MARKER.length)));
        }
        target = inside;
        if (marker.kind !== "card") return;
      }
      if (i === cardIdx && live) {
        target.push({ key, node: <React.Fragment key={key}><FindingCard card={live.card} revising={live.revising} compact={compact} />{evidence}</React.Fragment> });
        return;
      }
      if (isHiddenPart(part as ToolPart) || isAskPart(part.type)) return;
      if (part.type === "text") target.push(text(key, part.text));
      else if (part.type === "reasoning") target.push({ key, step: true, node: <li key={key}><ReasoningBlock content={part.text} isAnimating={isAnimating} /></li> });
      else if (part.type === "file") target.push({ key, node: <FileAttachment key={key} part={part as FilePartLike} /> });
      else if (isProviderTool(part.type)) target.push({ key, step: true, node: <ProviderStep key={key} part={snapshot(part)} isAnimating={isAnimating} /> });
      else if (part.type.startsWith("tool-")) target.push({ key, step: true, node: <li key={key} className="empty:hidden"><OtherToolPart part={snapshot(part)} isAnimating={isAnimating} /></li> });
    });

    return (
      <ResultLookupProvider value={resultLookup(stepParts)}>
        <div className={cn("space-y-4", compact && "space-y-3")}>
          {flow(before)}
          {inside.length > 0 && (
            <section
              key="analysis"
              aria-label="Analysis"
              // On a phone the box runs edge to edge, so the cards inside are as wide as the chat input.
              className={cn(
                "space-y-4 rounded-lg border border-primary/20 bg-primary-tint px-5 py-4",
                compact ? "space-y-3 px-4 py-3" : "max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0 max-sm:px-4",
              )}
            >
              {flow(inside)}
            </section>
          )}
          {asked && <AskCard input={asked.input} state={isAnimating ? CLOSED : ask} onPick={onAsk} compact={compact} />}
        </div>
      </ResultLookupProvider>
    );
  },
  (prev, next) => {
    if (prev.isAnimating || next.isAnimating) return false;
    if (prev.compact !== next.compact) return false;
    if (!sameAsk(prev.ask, next.ask) || prev.onAsk !== next.onAsk) return false;
    if (prev.parts === next.parts) return true;
    // A tool part changing state keeps the array length but swaps the part object.
    if (prev.parts.length !== next.parts.length) return false;
    return prev.parts.every((p, i) => p === next.parts[i]);
  },
);
