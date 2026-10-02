import React from "react";
import type { UIMessage } from "ai";
import { ChevronRight, Download, FileText, Loader2 } from "lucide-react";
import { Streamdown } from "streamdown";
import { ANALYSIS_MARKER, findAnalysisMarker } from "@tracer-sh/shared";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MD_CONTROLS, MD_LINK_SAFETY } from "../../lib/markdown";
import type { ProgressStore } from "../../lib/progress-store";
import { ReasoningBlock } from "./ReasoningBlock";
import { Narration, OtherToolPart, ProviderStep, isHiddenPart, isMonitorTool, isProviderTool, providerOf, stepQueryCount, type ToolPart } from "./ToolParts";
import { providerLabel } from "../../lib/providers";
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
              <iframe src={part.url} title={label} className="size-full rounded-md border bg-card" />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AnswerText({ text, isAnimating, compact }: { text: string; isAnimating: boolean; compact: boolean }) {
  if (!text.trim()) return null;
  return (
    <div className={compact ? ANSWER_PROSE_COMPACT : ANSWER_PROSE}>
      <Streamdown isAnimating={isAnimating} controls={MD_CONTROLS} linkSafety={MD_LINK_SAFETY}>{text}</Streamdown>
    </div>
  );
}

interface Props {
  parts: UIMessage["parts"];
  isAnimating: boolean;
  progressStore: ProgressStore;
  compact?: boolean;
}

/** One reply: the provider work folds into an "Investigated" section, the answer reads as prose below it. */
export const MessageParts = React.memo(
  function MessageParts({ parts, isAnimating, progressStore, compact = false }: Props) {
    if (parts.length === 0 && !isAnimating) {
      return <p className="text-sm text-muted-foreground">Interrupted before a reply.</p>;
    }

    // The analysis marker splits work from answer; without one, the answer is everything after the last query.
    const marker = findAnalysisMarker(parts);
    let workEnd = 0;
    if (marker) workEnd = marker.partIdx;
    else parts.forEach((p, i) => { if (isProviderTool(p.type)) workEnd = i + 1; });

    const work: Array<{ part: Part; key: string; text?: string }> = [];
    const answer: Array<{ part: Part; key: string; text?: string }> = [];
    const aside: Array<{ part: Part; key: string }> = [];
    parts.forEach((part, i) => {
      if (isHiddenPart(part as ToolPart)) return;
      if (marker && i === marker.partIdx) {
        if (marker.kind === "text" && part.type === "text") {
          work.push({ part, key: `${i}`, text: part.text.slice(0, marker.charIdx) });
          answer.push({ part, key: `${i}-after`, text: part.text.slice(marker.charIdx + ANALYSIS_MARKER.length) });
        }
        return;
      }
      if (i >= workEnd) answer.push({ part, key: `${i}` });
      else if (part.type === "file" || isMonitorTool(part.type)) aside.push({ part, key: `${i}` });
      else work.push({ part, key: `${i}` });
    });

    const steps = work.filter((w) => isProviderTool(w.part.type));
    const running = isAnimating && answer.length === 0;

    const renderWork = ({ part, key, text }: (typeof work)[number]) => {
      if (part.type === "text") return <li key={key}><Narration content={text ?? part.text} isAnimating={isAnimating} /></li>;
      if (part.type === "reasoning") return <li key={key}><ReasoningBlock content={part.text} isAnimating={isAnimating} /></li>;
      if (isProviderTool(part.type)) return <ProviderStep key={key} part={part as ToolPart} progressStore={progressStore} />;
      return <li key={key}><OtherToolPart part={part as ToolPart} /></li>;
    };

    const renderAnswer = ({ part, key, text }: (typeof answer)[number]) => {
      if (part.type === "text") return <AnswerText key={key} text={text ?? part.text} isAnimating={isAnimating} compact={compact} />;
      if (part.type === "reasoning") return <ReasoningBlock key={key} content={part.text} isAnimating={isAnimating} />;
      if (part.type === "file") return <FileAttachment key={key} part={part as FilePartLike} />;
      if (isProviderTool(part.type)) {
        return (
          <ol key={key}>
            <ProviderStep part={part as ToolPart} progressStore={progressStore} />
          </ol>
        );
      }
      return <OtherToolPart key={key} part={part as ToolPart} />;
    };

    let investigation: React.ReactNode = null;
    if (steps.length > 0) {
      const providers = [...new Set(steps.map((s) => providerLabel(providerOf(s.part.type))))].join(", ");
      const queries = steps.reduce((n, s) => n + stepQueryCount(s.part as ToolPart, progressStore), 0);
      const label = [running ? "Investigating" : "Investigated", providers, queries > 0 && `${queries} ${queries === 1 ? "query" : "queries"}`]
        .filter(Boolean)
        .join(" · ");
      investigation = (
        <Collapsible defaultOpen={isAnimating}>
          <CollapsibleTrigger className="group/trigger -ml-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px]/[18px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            <ChevronRight className="size-3.5 shrink-0 transition-transform duration-200 ease-out group-data-[state=open]/trigger:rotate-90" aria-hidden="true" />
            {running && <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />}
            <span className="min-w-0 truncate">{label}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ol className="mt-3 space-y-5">{work.map(renderWork)}</ol>
          </CollapsibleContent>
        </Collapsible>
      );
    } else if (work.length > 0) {
      investigation = <ol className="space-y-3">{work.map(renderWork)}</ol>;
    }

    return (
      <div className={cn("space-y-4", compact && "space-y-3")}>
        {investigation}
        {aside.map(({ part, key }) => (part.type === "file" ? <FileAttachment key={key} part={part as FilePartLike} /> : <OtherToolPart key={key} part={part as ToolPart} />))}
        {answer.map(renderAnswer)}
      </div>
    );
  },
  (prev, next) => {
    if (prev.isAnimating || next.isAnimating) return false;
    if (prev.compact !== next.compact || prev.progressStore !== next.progressStore) return false;
    if (prev.parts === next.parts) return true;
    // A tool part changing state keeps the array length but swaps the part object.
    if (prev.parts.length !== next.parts.length) return false;
    return prev.parts.every((p, i) => p === next.parts[i]);
  },
);
