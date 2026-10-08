import type { ReactNode } from "react";

// Only **bold** and `code`, on one line each; anything else, including an unbalanced marker, stays literal text.
const MARKS = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;

export function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKS)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] !== undefined
      ? <strong key={m.index} className="font-semibold text-foreground">{m[1]}</strong>
      : <code key={m.index} className="rounded bg-muted px-1 font-mono text-[0.9em] text-foreground [overflow-wrap:anywhere]">{m[2]}</code>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

export const stripInline = (text: string) => text.replace(MARKS, (_, b?: string, c?: string) => b ?? c ?? "");
