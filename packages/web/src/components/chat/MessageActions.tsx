import type { ReactNode, RefObject } from "react";
import type { UIMessage } from "ai";
import { Copy, Download, ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { ANALYSIS_MARKER, findAnalysisMarker } from "@tracer-sh/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { encodePngWithPayload } from "../../lib/png-steg";

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

/** Plain text of a message: text and tool inputs; reasoning and tool results are skipped. */
export function extractMessageText(parts: UIMessage["parts"]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      chunks.push(stripMarkdown(part.text.replace(ANALYSIS_MARKER, "")));
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

export function copyText(text: string, message: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(message),
    () => toast.error("Couldn't copy to the clipboard"),
  );
}

// Browsers refuse canvases past ~16k px a side (Safari: ~16.7M px total), so long transcripts render at a lower scale.
const MAX_CANVAS_SIDE = 16_000;
const MAX_CANVAS_AREA = 16_000_000;

async function capture(el: HTMLElement): Promise<Blob> {
  const { domToBlob } = await import("modern-screenshot");
  const w = Math.max(1, el.scrollWidth);
  const h = Math.max(1, el.scrollHeight);
  const scale = Math.min(2, MAX_CANVAS_SIDE / Math.max(w, h), Math.sqrt(MAX_CANVAS_AREA / (w * h)));
  return domToBlob(el, { scale, type: "image/png", backgroundColor: getComputedStyle(document.body).backgroundColor });
}

/** `<prefix>-YYYY-MM-DD-HH-MM.png` in local time. */
export function stampedPngName(prefix: string) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.png`;
}

function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** PNG of an element, downloaded as a file. */
export async function downloadImage(el: HTMLElement, name: string) {
  try {
    saveFile(await capture(el), name);
    toast.success("Image saved", { description: name });
  } catch {
    toast.error("Couldn't create the image");
  }
}

export interface SourceMeta {
  sourceTitle?: string;
  sourceCreatedAt?: number;
  /** Fetches the freshest title at click time; generated titles can land after the stream ends. */
  resolveSourceTitle?: () => Promise<string | undefined>;
}

/** PNG that carries the reply's analysis parts, so dropping it back into Tracer re-imports it. */
async function downloadReplyImage(el: HTMLElement, analysis: UIMessage["parts"], meta: SourceMeta) {
  try {
    const bytes = new Uint8Array(await (await capture(el)).arrayBuffer());
    const payload = JSON.stringify({
      v: 1,
      kind: "analysis",
      sourceTitle: (await meta.resolveSourceTitle?.()) ?? meta.sourceTitle ?? "",
      sourceCreatedAt: meta.sourceCreatedAt ?? Math.floor(Date.now() / 1000),
      parts: analysis,
    });
    if (payload.length > 2 * 1024 * 1024) {
      toast.error("This reply is too large to embed in an image");
      return;
    }
    const out = await encodePngWithPayload(bytes, new TextEncoder().encode(payload));
    const name = stampedPngName("analysis");
    saveFile(new Blob([out.buffer as ArrayBuffer], { type: "image/png" }), name);
    toast.success("Image saved", { description: name });
  } catch {
    toast.error("Couldn't create the image");
  }
}

async function copyImage(el: HTMLElement) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": capture(el) })]);
    toast.success("Image copied");
  } catch {
    toast.error("Couldn't copy the image");
  }
}

/** Actions under a message. `hoverOnly` reveals them on hover or focus-within (always on touch); `download` applies only to replies with an analysis. */
export function MessageActions({
  parts,
  contentRef,
  download = false,
  hoverOnly = false,
  meta = {},
  children,
  className,
}: {
  parts: UIMessage["parts"];
  contentRef: RefObject<HTMLElement | null>;
  download?: boolean;
  hoverOnly?: boolean;
  meta?: SourceMeta;
  children?: ReactNode;
  className?: string;
}) {
  const analysis = download ? analysisParts(parts) : null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1",
        hoverOnly &&
          "transition-opacity duration-150 group-focus-within/turn:pointer-events-auto group-focus-within/turn:opacity-100 group-hover/turn:pointer-events-auto group-hover/turn:opacity-100 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        onClick={() => {
          const text = extractMessageText(analysis ?? parts);
          if (text) copyText(text, "Copied as text");
        }}
      >
        <Copy />
        Copy text
      </Button>
      <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => contentRef.current && copyImage(contentRef.current)}>
        <ImageIcon />
        Copy image
      </Button>
      {analysis && (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => contentRef.current && downloadReplyImage(contentRef.current, analysis, meta)}
        >
          <Download />
          Download image
        </Button>
      )}
      {children}
    </div>
  );
}
