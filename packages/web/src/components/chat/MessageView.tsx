import { memo, useRef, type ReactNode } from "react";
import type { UIMessage } from "ai";
import { Bell, FileText, Timer } from "lucide-react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { ProgressStore } from "../../lib/progress-store";
import { formatTime } from "../../lib/format";
import { FoldTrigger } from "../common/FoldTrigger";
import { FileAttachment, MessageParts } from "./MessageParts";
import { MessageActions, extractMessageText, type SourceMeta } from "./MessageActions";

export const POST_MORTEM_PROMPT = `Generate a Post-Mortem Report for this investigation session.

Structure it with these sections:
- **Summary**: Concise overview of the incident and key findings
- **Impact**: Quantified impact based on data discovered (error rates, affected services, latency, etc.)
- **Timeline**: Chronological sequence of key events and findings with timestamps
- **Root Cause**: Technical explanation of what caused the issue
- **Resolution**: What fixed the issue or recommended next steps

Base the report entirely on the investigation data and findings from this conversation. Be specific — include actual error messages, metric values, service names, and query results where relevant.`;

const MONITOR_FIRED = /^Monitor "(.+)" triggered\./;
const FOLLOW_UP = /^Follow-up timer \(set .+?, due .+?, now (.+?)\): (.+?)\. Check it now\./;

interface ServerEvent {
  kind: "alert" | "followup";
  text: string;
  time?: string;
}

/** Messages the server sends on the user's behalf: a monitor firing or a follow-up timer waking the chat. */
function eventOf(text: string): ServerEvent | null {
  const fired = MONITOR_FIRED.exec(text);
  if (fired) {
    const value = /^Value: (.+?) \(condition: value (.+)\)$/m.exec(text);
    const groups = text.split("Groups that fired:\n")[1]?.split("\n\n")[0]?.split("\n").map((l) => l.replace(/^- /, "")).filter(Boolean) ?? [];
    const windowEnd = /^Window: \S+ to (\S+)/m.exec(text)?.[1];
    const ts = windowEnd ? Date.parse(windowEnd) / 1000 : NaN;
    const detail = [groups.slice(0, 3).join(", "), value && `value ${value[1]} (${value[2]})`].filter(Boolean).join(" · ");
    return { kind: "alert", text: `${fired[1]} fired${detail ? `: ${detail}` : ""}`, time: Number.isFinite(ts) ? formatTime(ts) : undefined };
  }
  const followUp = FOLLOW_UP.exec(text);
  if (followUp) return { kind: "followup", text: `Follow-up: ${followUp[2]}`, time: followUp[1] };
  return null;
}

export const textOf = (msg: UIMessage) => msg.parts.find((p): p is { type: "text"; text: string } => p.type === "text")?.text ?? "";

/** The monitor that started an alert session, from its first message. */
export function monitorNameOf(messages: UIMessage[]): string | undefined {
  const first = messages.find((m) => m.role === "user");
  return first ? MONITOR_FIRED.exec(textOf(first))?.[1] : undefined;
}

const isPostMortem = (msg: UIMessage) => msg.role === "user" && textOf(msg).trim() === POST_MORTEM_PROMPT;

/** The whole session as plain text, for "Copy as text". */
export function transcriptOf(title: string, messages: UIMessage[]): string {
  const lines = messages.map((m) => {
    if (m.role !== "user") return extractMessageText(m.parts);
    if (isPostMortem(m)) return "You: Post-mortem requested";
    return eventOf(textOf(m))?.text ?? `You: ${textOf(m)}`;
  });
  return [title, ...lines].filter(Boolean).join("\n\n");
}

function EventRow({ event, prompt }: { event: ServerEvent; prompt: string }) {
  const Icon = event.kind === "alert" ? Bell : Timer;
  return (
    <Collapsible>
      <FoldTrigger chevronEnd chevronClassName="text-muted-foreground" className="flex w-full items-center gap-3 rounded-lg text-left">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full",
            event.kind === "alert" ? "bg-destructive-tint text-destructive" : "bg-primary-tint text-primary",
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 text-sm text-ink-2">{event.text}</span>
        {event.time && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{event.time}</span>}
        <span className="sr-only">Show the message Tracer received</span>
      </FoldTrigger>
      <CollapsibleContent>
        <pre className="mt-2 ml-10 max-h-80 overflow-auto rounded-md border bg-card px-3 py-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{prompt}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export interface MessageViewOptions {
  /** Extra actions after the defaults (edit, delete from here). */
  actions?: ReactNode;
  showActions?: boolean;
  /** Replaces the message body, e.g. an edit form. */
  body?: ReactNode;
  dimmed?: boolean;
  /** Pinned to the end of the action row, always visible (e.g. "Summarize up to here"). */
  footer?: ReactNode;
}

interface MessageViewProps extends MessageViewOptions {
  msg: UIMessage;
  isAnimating: boolean;
  progressStore: ProgressStore;
  compact?: boolean;
  meta?: SourceMeta;
}

export const MessageView = memo(function MessageView({ msg, isAnimating, progressStore, compact = false, meta, actions, showActions = !isAnimating, body, dimmed, footer }: MessageViewProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const isUser = msg.role === "user";
  const text = isUser ? textOf(msg) : "";
  const event = isUser ? eventOf(text) : null;

  let content: ReactNode;
  if (body) content = body;
  else if (event) content = <EventRow event={event} prompt={text} />;
  else if (isPostMortem(msg)) {
    content = (
      <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-[13px]/[18px] text-ink-2">
        <FileText className="size-3.5 text-muted-foreground" aria-hidden="true" />
        Post-mortem requested
      </span>
    );
  } else if (isUser) {
    const files = msg.parts.filter((p) => p.type === "file");
    content = (
      <div className="flex max-w-[85%] flex-col items-end gap-2 sm:max-w-[75%]">
        {files.map((f, i) => <FileAttachment key={i} part={f as Parameters<typeof FileAttachment>[0]["part"]} />)}
        {text && <p className={cn("rounded-2xl bg-muted px-4 py-2.5 whitespace-pre-wrap [overflow-wrap:anywhere]", compact ? "text-sm" : "text-base")}>{text}</p>}
      </div>
    );
  } else {
    content = <MessageParts parts={msg.parts} isAnimating={isAnimating} progressStore={progressStore} compact={compact} />;
  }

  const plain = isUser && !event;
  return (
    <article
      aria-label={isUser ? "Your message" : "Tracer reply"}
      aria-busy={isAnimating || undefined}
      className={cn("group/turn relative space-y-2 transition-opacity", dimmed && "pointer-events-none opacity-40")}
    >
      <div ref={contentRef} className={cn("bg-background", plain && !body && "flex justify-end")}>
        {content}
      </div>
      {(showActions || footer) && !body && (
        <div
          className={cn(
            "flex items-center gap-1",
            plain ? "justify-end" : "-ml-2",
            event && "ml-8",
            // Your side of the thread floats its hover actions into the gap below, so turns keep one rhythm.
            isUser && !footer && "[@media(hover:hover)]:absolute [@media(hover:hover)]:inset-x-0 [@media(hover:hover)]:top-full [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:z-10 [@media(hover:hover)]:mt-1",
          )}
        >
          {showActions && (
            <MessageActions parts={msg.parts} contentRef={contentRef} download={!isUser} hoverOnly={isUser} meta={meta}>
              {actions}
            </MessageActions>
          )}
          {footer && <div className={cn(!plain && "ml-auto")}>{footer}</div>}
        </div>
      )}
    </article>
  );
});
