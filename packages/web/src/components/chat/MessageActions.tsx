import type { ReactNode, RefObject } from "react";
import type { UIMessage } from "ai";
import { Copy, Download, ImageIcon, Share } from "lucide-react";
import { toast } from "sonner";
import { ANALYSIS_MARKER, findAnalysisMarker, findingFromMessages, findingMarkdown } from "@tracer-sh/shared";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { IS_IOS } from "../../lib/platform";
import { encodePngWithPayload } from "../../lib/png-steg";
import { serialQueue } from "../../lib/serial";

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
  const finding = findingFromMessages([{ parts }]);
  if (finding) chunks.push(stripMarkdown(findingMarkdown(finding)));
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

// Browsers refuse canvases past ~16k px a side (Safari: ~16.7M px total), so long transcripts render at a lower scale.
const MAX_CANVAS_SIDE = 16_000;
const MAX_CANVAS_AREA = 16_000_000;

// Content width of the chat column (Transcript COLUMN: 808px minus 2 x 24px padding) on desktop, so images read the same on every device.
const IMAGE_WIDTH = 760;
const IMAGE_MARGIN = 24;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Lays the live element out at IMAGE_WIDTH, off screen, in the desktop box style, so charts re-measure to that width.
 * A placeholder holds its place in the page; the returned function puts everything back.
 */
async function layoutAtImageWidth(el: HTMLElement): Promise<() => void> {
  const placeholder = document.createElement("div");
  placeholder.style.height = `${el.getBoundingClientRect().height}px`;
  el.before(placeholder);
  const saved = el.style.cssText;
  el.style.cssText += `;position:fixed;left:-${IMAGE_WIDTH * 2}px;top:0;width:${IMAGE_WIDTH}px;margin:0;padding:16px 20px;border-width:1px;border-radius:var(--radius)`;
  // Chart containers measure with a ResizeObserver and re-render in a later frame.
  await nextFrame();
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, 150));
  return () => {
    el.style.cssText = saved;
    placeholder.remove();
  };
}

// A second capture would read the first one's off-screen style as the original and leave the element there.
const oneCapture = serialQueue();

/** PNG of an element. `boxed` renders it as a card at a fixed width on the page background; otherwise it keeps its on-screen size. */
const capture = (el: HTMLElement, boxed = false): Promise<Blob> => oneCapture(() => captureNow(el, boxed));

async function captureNow(el: HTMLElement, boxed: boolean): Promise<Blob> {
  const { domToBlob, domToCanvas } = await import("modern-screenshot");
  const restore = boxed ? await layoutAtImageWidth(el) : undefined;
  try {
    const margin = boxed ? IMAGE_MARGIN : 0;
    const w = Math.max(1, el.scrollWidth) + 2 * margin;
    const h = Math.max(1, el.scrollHeight) + 2 * margin;
    const scale = Math.min(2, MAX_CANVAS_SIDE / Math.max(w, h), Math.sqrt(MAX_CANVAS_AREA / (w * h)));
    const background = getComputedStyle(document.body).backgroundColor;
    // A backgroundColor option would override the element's own background, so the box would lose its tint.
    if (!boxed) return await domToBlob(el, { scale, type: "image/png", backgroundColor: background });
    const inner = await domToCanvas(el, { scale });
    const out = document.createElement("canvas");
    out.width = inner.width + Math.round(2 * margin * scale);
    out.height = inner.height + Math.round(2 * margin * scale);
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("No canvas context");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(inner, Math.round(margin * scale), Math.round(margin * scale));
    return await new Promise<Blob>((resolve, reject) => out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png"));
  } finally {
    restore?.();
  }
}

/** `<prefix>-YYYY-MM-DD-HH-MM.png` in local time. */
export function stampedPngName(prefix: string) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}.png`;
}

/** Phone browser whose share sheet accepts image files; the iOS app has its own path. */
const CAN_SHARE_IMAGE =
  !IS_IOS &&
  typeof window !== "undefined" &&
  typeof navigator !== "undefined" &&
  window.matchMedia?.("(pointer: coarse)").matches === true &&
  navigator.canShare?.({ files: [new File([], "x.png", { type: "image/png" })] }) === true;

const SHARES_IMAGE = IS_IOS || CAN_SHARE_IMAGE;

function downloadFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Saves a PNG: the native share sheet (iOS app, phone browsers) or a file download. Returns false when nothing was saved yet. */
async function saveFile(blob: Blob, name: string): Promise<boolean> {
  if (IS_IOS) {
    // The share sheet needs a file path: navigator.share would run after the capture and lose its user activation.
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import("@capacitor/filesystem"), import("@capacitor/share")]);
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const { uri } = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
    try {
      await Share.share({ files: [uri] });
      return true;
    } catch (err) {
      if (err instanceof Error && /cancel/i.test(err.message)) return false;
      throw err;
    } finally {
      void Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => {});
    }
  }
  if (CAN_SHARE_IMAGE) {
    const file = new File([blob], name, { type: "image/png" });
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (err) {
      const errName = err instanceof Error ? err.name : "";
      if (errName === "AbortError") return false;
      if (errName === "NotAllowedError") {
        // The capture outlasted the tap's user activation; a fresh tap on the toast action restores it.
        toast("Image ready", {
          action: { label: "Share", onClick: () => void navigator.share({ files: [file] }).catch(() => {}) },
        });
        return false;
      }
    }
  }
  downloadFile(blob, name);
  return true;
}

/** Label of the save-image action; iOS and phone browsers share instead of downloading. */
export const SAVE_IMAGE_LABEL = SHARES_IMAGE ? "Share image" : "Download image";

/** Action button under a message: icon only on phones, with the label kept for screen readers. */
export function MessageActionButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="xs" className="text-muted-foreground max-sm:size-8" onClick={onClick}>
      {icon}
      <span className="max-sm:sr-only">{label}</span>
    </Button>
  );
}

/** The reply's Analysis section when it has one, so images skip the work steps. */
const imageTarget = (el: HTMLElement) => el.querySelector<HTMLElement>('section[aria-label="Analysis"]') ?? el;

/** Captures the reply's Analysis box at the fixed image width; a reply without one keeps its on-screen size. */
const captureReply = (el: HTMLElement) => {
  const target = imageTarget(el);
  return capture(target, target !== el);
};

/** PNG of an element, downloaded as a file; `reply` captures the reply's Analysis box instead. */
export async function downloadImage(el: HTMLElement, name: string, reply = false) {
  try {
    if (await saveFile(await (reply ? captureReply(el) : capture(el)), name)) toast.success("Image saved", { description: name });
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
    const bytes = new Uint8Array(await (await captureReply(el)).arrayBuffer());
    const payload = JSON.stringify({
      v: 1,
      kind: "analysis",
      sourceTitle: (await meta.resolveSourceTitle?.()) ?? meta.sourceTitle ?? "",
      sourceCreatedAt: meta.sourceCreatedAt ?? Math.floor(Date.now() / 1000),
      parts: analysis,
    });
    if (payload.length > 2 * 1024 * 1024) {
      toast.error("This reply is too large to embed in an image", {
        description: "Save a plain image instead.",
        action: { label: "Save plain image", onClick: () => void downloadImage(el, stampedPngName("analysis"), true) },
      });
      return;
    }
    const out = await encodePngWithPayload(bytes, new TextEncoder().encode(payload));
    const name = stampedPngName("analysis");
    if (await saveFile(new Blob([out.buffer as ArrayBuffer], { type: "image/png" }), name)) toast.success("Image saved", { description: name });
  } catch {
    toast.error("Couldn't create the image");
  }
}

async function copyImage(el: HTMLElement) {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": captureReply(el) })]);
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
      <MessageActionButton
        icon={<Copy />}
        label="Copy text"
        onClick={() => {
          const text = extractMessageText(analysis ?? parts);
          if (text) copyText(text, "Copied as text");
        }}
      />
      <MessageActionButton icon={<ImageIcon />} label="Copy image" onClick={() => contentRef.current && copyImage(contentRef.current)} />
      {analysis && (
        <MessageActionButton
          icon={SHARES_IMAGE ? <Share /> : <Download />}
          label={SAVE_IMAGE_LABEL}
          onClick={() => contentRef.current && downloadReplyImage(contentRef.current, analysis, meta)}
        />
      )}
      {children}
    </div>
  );
}
