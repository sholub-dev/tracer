import { hasErrorOutput } from "./chat-utils";
import { CONFIDENCE, FINDING_KIND, VERDICT, cardRejected, asUnverified, cardUnchecked, normalizeFinding, type Finding } from "@tracer-sh/shared";

export interface CardData {
  kind?: Finding["kind"];
  verdict?: Finding["verdict"];
  confidence?: Finding["confidence"];
  title: string;
  answer: string;
  explanation: { statement: string; source: string }[];
  unknown: string;
  action: string;
}

type CardPart = { type: string; state?: string; input?: unknown; output?: unknown };

const LEGACY = ["headline", "rootCause", "chain", "impact", "gap", "details", "points", "evidence", "happened", "cause", "toConfirm"];

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const oneOf = <T extends string>(list: readonly T[], v: unknown) => list.find((x) => x === v);

/** Reads whatever fields a card input has so far; null when it holds nothing to show yet. */
export function partialFinding(input: unknown, streaming = false): CardData | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const legacy = !("title" in raw || "answer" in raw || "explanation" in raw) && LEGACY.some((k) => k in raw);
  const o = (legacy ? normalizeFinding(raw) : raw) as Record<string, unknown>;
  const items = (Array.isArray(o.explanation) ? o.explanation : []).flatMap((e) => {
    const statement = str((e as { statement?: unknown } | null)?.statement);
    return statement ? [{ statement, source: str((e as { source?: unknown }).source) }] : [];
  });
  // The last source is still being typed until a later field starts.
  if (streaming && items.length && !("unknown" in o || "action" in o)) items[items.length - 1].source = "";
  const kind = oneOf(FINDING_KIND, o.kind);
  const data: CardData = {
    kind,
    verdict: oneOf(VERDICT, o.verdict),
    confidence: oneOf(CONFIDENCE, o.confidence) ?? (kind === "root_cause" && !streaming ? "unverified" : undefined),
    title: str(o.title),
    answer: str(o.answer),
    explanation: items,
    unknown: str(o.unknown),
    action: str(o.action),
  };
  return data.title || data.answer || items.length ? data : null;
}

export interface LiveCard {
  card: CardData;
  revising: boolean;
}

/** The card to show: the latest report_finding part with content. While the run goes, a card sent back stays until the next one has content; after it, the last recorded card wins, and a card that never passed shows as unverified. */
export function latestCard(parts: ReadonlyArray<CardPart>, isAnimating: boolean): LiveCard | null {
  let failed: CardData | null = null;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.type !== "tool-report_finding") continue;
    const card = partialFinding(p.input, p.state === "input-streaming");
    if (!card) continue;
    const rejected = cardRejected(p.output) || p.state === "output-error";
    if (isAnimating || !rejected) return { card: cardUnchecked(p.output) ? asUnverified(card) : card, revising: isAnimating && rejected };
    failed ??= asUnverified(card);
  }
  return failed && { card: failed, revising: false };
}

const succeeded = (p: { state?: string; output?: unknown }) => p.state === "output-available" && !hasErrorOutput(p.output);

/** For each source, the last part of the turn whose input title matches it, ignoring case; a successful one before a failed one. */
export function matchSources<T extends { input?: unknown; state?: string; output?: unknown }>(sources: string[], parts: ReadonlyArray<T>): (T | undefined)[] {
  return sources.map((s) => {
    const titled = parts.filter((p) => str((p.input as { title?: unknown } | undefined)?.title).toLowerCase() === s.toLowerCase());
    return titled.findLast(succeeded) ?? titled.at(-1);
  });
}
