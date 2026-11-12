import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { ANALYSIS_MARKER, askUserText, CLIENT_TOOL_NAMES, findAnalysisMarker, findingFromMessages, findingMarkdown, resultRefsToText } from "@tracer-sh/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Strip markdown syntax to produce clean plain text for pasting into Slack etc. */
function stripMarkdown(text: string): string {
  // Code is stashed first so emphasis/list rules never touch identifiers like error_rate_by_host.
  const code: string[] = [];
  const stash = (s: string) => `\u0000${code.push(s) - 1}\u0000`;
  return text
    .replace(/^```[^\n]*\n([\s\S]*?)\n?^```[ \t]*$/gm, (_, body: string) => stash(body))
    .replace(/`([^`\n]+)`/g, (_, c: string) => stash(c))
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\w)__(.+?)__(?!\w)/g, "$1")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^>\s+/gm, "")
    .replace(/^(\s*)[-*+]\s+/gm, "$1")
    .replace(/^(\s*)\d+\.\s+/gm, "$1")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)]);
}

/** Plain text of a message: text, the question to the person and tool inputs; reasoning and tool results are skipped. */
export function extractMessageText(parts: UIMessage["parts"]): string {
  const chunks: string[] = [];
  const finding = findingFromMessages([{ parts }]);
  if (finding) chunks.push(stripMarkdown(findingMarkdown(finding)));
  for (const part of parts) {
    if (part.type === "text") {
      chunks.push(stripMarkdown(resultRefsToText(part.text.replace(ANALYSIS_MARKER, ""))));
    } else if (part.type === CLIENT_TOOL_NAMES.ASK_USER) {
      const ask = askUserText((part as { input?: unknown }).input);
      if (ask) chunks.push(ask);
    } else if (part.type !== "reasoning") {
      const tp = part as unknown as { input?: { task?: string; query?: string } };
      if (tp.input?.task) chunks.push(`Task: ${tp.input.task}`);
      if (tp.input?.query) chunks.push(`Query: ${tp.input.query}`);
    }
  }
  return chunks.join("\n\n").trim();
}

/** The parts after the analysis marker; null when there is none. */
function analysisParts(parts: UIMessage["parts"]): UIMessage["parts"] | null {
  const marker = findAnalysisMarker(parts);
  if (!marker) return null;
  const out: UIMessage["parts"] = [];
  for (let i = marker.partIdx; i < parts.length; i++) {
    const p = parts[i];
    if (i > marker.partIdx) out.push(p);
    else if (marker.kind === "text" && p.type === "text") {
      const after = p.text.slice(marker.charIdx + ANALYSIS_MARKER.length);
      if (after.trim()) out.push({ type: "text", text: after });
    }
  }
  return out;
}

/** Copy through a hidden textarea, for contexts where the async clipboard API is missing or refused. */
function execCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

export async function copyText(text: string, message: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    if (!execCopy(text)) {
      toast.error("Couldn't copy to the clipboard");
      return;
    }
  }
  toast.success(message);
}

/** Action button under a message: icon only on phones, with the label kept for screen readers. */
export function MessageActionButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="xs" className="text-muted-foreground max-sm:size-8" onClick={onClick}>
      {icon}
      <span className="max-sm:sr-only">{label}</span>
    </Button>
  );
}

/** Actions under a message. `hoverOnly` reveals them on hover or focus-within (always on touch). */
export function MessageActions({ parts, hoverOnly = false, children, className }: { parts: UIMessage["parts"]; hoverOnly?: boolean; children?: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1",
        hoverOnly &&
          "transition-opacity duration-150 group-focus-within/turn:pointer-events-auto group-focus-within/turn:opacity-100 group-hover/turn:pointer-events-auto group-hover/turn:opacity-100 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0",
        className,
      )}
    >
      <MessageActionButton
        icon={<Copy />}
        label="Copy text"
        onClick={() => {
          const text = extractMessageText(analysisParts(parts) ?? parts);
          if (text) copyText(text, "Copied as text");
        }}
      />
      {children}
    </div>
  );
}
