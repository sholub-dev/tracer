import type { ReactNode } from "react";

// Only **bold** and `code`, on one line each; anything else, including an unbalanced marker, stays literal text.
const MARKS = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

// A measured figure: 2+ digits, or a decimal, percent or unit; not part of a name, a time or an id.
const FIGURE = /(?<![\w:./-])[+\u2212-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:%|ms\b|s\b|x\b)|(?<=\d\d|\.\d+))(?![\w:/-])/g;

function figures(text: string, at: number): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(FIGURE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<strong key={`${at}-${m.index}`} className="font-semibold text-foreground tabular-nums">{m[0]}</strong>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

export function Inline({ text, highlight = false }: { text: string; highlight?: boolean }) {
  const out: ReactNode[] = [];
  let last = 0;
  const plain = (from: number, to: number) => (highlight ? figures(text.slice(from, to), from) : [text.slice(from, to)]);
  for (const m of text.matchAll(MARKS)) {
    if (m.index > last) out.push(...plain(last, m.index));
    out.push(m[1] !== undefined
      ? <strong key={m.index} className="font-semibold text-foreground">{m[1]}</strong>
      : <code key={m.index} className="rounded bg-muted px-1 font-mono text-[0.9em] text-foreground [overflow-wrap:anywhere]">{m[2]}</code>);
    last = m.index + m[0].length;
  }
  out.push(...plain(last, text.length));
  return <>{out}</>;
}

export const stripInline = (text: string) => text.replace(MARKS, (_, b?: string, c?: string) => b ?? c ?? "");
