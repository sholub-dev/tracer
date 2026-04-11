import { useState, useCallback, type RefObject } from "react";
import { domToPng } from "modern-screenshot";
import { theme } from "../../lib/theme";
import type { UIMessage } from "ai";
import { ANALYSIS_MARKER } from "./MessageParts";

/** Strip markdown syntax to produce clean plain text for pasting into Slack etc. */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")           // headers
    .replace(/\*\*(.+?)\*\*/g, "$1")       // bold
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")           // italic
    .replace(/_(.+?)_/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")           // strikethrough
    .replace(/`([^`]+)`/g, "$1")           // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1") // images
    .replace(/^>\s+/gm, "")               // blockquotes
    .replace(/^(\s*)[-*+]\s+/gm, "$1")   // unordered list markers
    .replace(/^(\s*)\d+\.\s+/gm, "$1")   // ordered list markers
    .replace(/^```\w*\n?/gm, "")          // code fences
    .replace(/^```$/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "");      // horizontal rules
}

/** Extract text from message parts: includes text + tool inputs, skips tool results. */
function extractMessageText(parts: UIMessage["parts"]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      chunks.push(stripMarkdown(part.text.replace(ANALYSIS_MARKER, "")));
    } else if (part.type === "reasoning") {
      // Skip thinking
    } else {
      // Tool invocation — include input parameters only, skip results
      const tp = part as unknown as { input?: { task?: string; query?: string } };
      if (tp.input?.task) chunks.push(`Task: ${tp.input.task}`);
      if (tp.input?.query) chunks.push(`Query: ${tp.input.query}`);
    }
  }
  return chunks.join("\n\n").trim();
}

interface CopyMessageButtonProps {
  contentRef: RefObject<HTMLElement | null>;
  parts: UIMessage["parts"];
  size?: number;
}

export function CopyMessageButton({ contentRef, parts, size = 14 }: CopyMessageButtonProps) {
  const [textCopied, setTextCopied] = useState(false);
  const [imgCopied, setImgCopied] = useState(false);

  const handleTextCopy = useCallback(async () => {
    const text = extractMessageText(parts);
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setTextCopied(true);
    setTimeout(() => setTextCopied(false), 1500);
  }, [parts]);

  const handleScreenshot = useCallback(async () => {
    const el = contentRef.current;
    if (!el) return;
    try {
      const dataUrl = await domToPng(el, { scale: 2 });
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setImgCopied(true);
      setTimeout(() => setImgCopied(false), 1500);
    } catch {
      // Silent fail — domToPng or clipboard API not supported
    }
  }, [contentRef]);

  return (
    <>
      <button
        type="button"
        onClick={handleTextCopy}
        className={theme.chatActionButton}
        title={textCopied ? "Copied!" : "Copy as text"}
        aria-label={textCopied ? "Copied" : "Copy as text"}
      >
        {textCopied ? <CheckIcon size={size} /> : <ClipboardIcon size={size} />}
      </button>
      <button
        type="button"
        onClick={handleScreenshot}
        className={theme.chatActionButton}
        title={imgCopied ? "Copied!" : "Copy as image"}
        aria-label={imgCopied ? "Copied" : "Copy as image"}
      >
        {imgCopied ? <CheckIcon size={size} /> : <CameraIcon size={size} />}
      </button>
    </>
  );
}

// ── Icons ──

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ClipboardIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CameraIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  );
}
