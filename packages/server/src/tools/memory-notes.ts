import { eq, inArray } from "drizzle-orm";
import { unixNow, type MemoryInjection } from "@tracer-sh/shared";
import type { Db } from "../db/driver.js";
import { chatSessions, toolMemories } from "../db/schema.js";
import { CONFIG } from "../config.js";
import { enforceNoteLength, normalizeNote, sanitizeNote } from "./memory-executor.js";
import { decodeMessages } from "../lib/messages-codec.js";

type NoteRow = { id: number; toolName: string; note: string | null; createdAt?: number };
type Note = { id: number; toolName: string; note: string; createdAt: number };

const MAX_SESSIONS = 300;
const STOPWORDS = new Set(["the", "and", "for", "are", "but", "not", "you", "with", "this", "that", "from", "have", "was", "what", "why", "how", "when", "where", "who", "can", "does", "did", "use", "any", "all"]);

// One set per session keeps the system prompt byte-identical, so the prompt cache holds.
const sessionSets = new Map<string, Map<string, MemoryInjection>>();

/** Sanitized notes in creation order, with later copies of the same note dropped. */
export function prepareNotes(rows: NoteRow[]): Note[] {
  const seen = new Set<string>();
  const notes: Note[] = [];
  for (const r of [...rows].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id - b.id)) {
    const note = enforceNoteLength(sanitizeNote(r.note ?? ""));
    const key = normalizeNote(note);
    if (!note || seen.has(key)) continue;
    seen.add(key);
    notes.push({ id: r.id, toolName: r.toolName, note, createdAt: r.createdAt ?? 0 });
  }
  return notes;
}

const lineLength = (n: Note) => n.note.length + 3;

function fitsBudget(notes: Note[]): boolean {
  return notes.length <= CONFIG.memoryMaxNotes && notes.reduce((sum, n) => sum + lineLength(n), 0) <= CONFIG.memoryMaxChars;
}

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length >= 3 && !STOPWORDS.has(t)));
}

/** All notes when they fit the budget; otherwise the ones that share words with the message, then the newest. */
export function pickNotes(rows: NoteRow[], message = ""): MemoryInjection {
  const notes = prepareNotes(rows);
  if (fitsBudget(notes)) return { notes: notes.map(({ id, toolName, note }) => ({ id, toolName, note })), omitted: 0 };
  const wanted = tokens(message);
  const scored = notes.map((n) => ({ n, score: [...tokens(n.note)].filter((t) => wanted.has(t)).length }));
  const byRecency = (a: Note, b: Note) => b.createdAt - a.createdAt || b.id - a.id;
  const ranked = [
    ...scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || byRecency(a.n, b.n)).map((s) => s.n),
    ...scored.filter((s) => s.score === 0).map((s) => s.n).sort(byRecency),
  ];
  const chosen: Note[] = [];
  let chars = 0;
  for (const n of ranked) {
    if (chosen.length >= CONFIG.memoryMaxNotes) break;
    if (chars + lineLength(n) > CONFIG.memoryMaxChars) continue;
    chosen.push(n);
    chars += lineLength(n);
  }
  chosen.sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  return { notes: chosen.map(({ id, toolName, note }) => ({ id, toolName, note })), omitted: notes.length - chosen.length };
}

async function firstUserText(db: Db, sessionId: string): Promise<string> {
  const row = await db.select({ messages: chatSessions.messages }).from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  try {
    const first = decodeMessages(row?.messages ?? "[]").find((m) => m.role === "user");
    return (first?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
  } catch {
    return "";
  }
}

/** The notes of one data source for a session: chosen on the session's first run, the same afterwards. */
export async function memorySetFor(db: Db, sessionId: string | undefined, toolName: string, rows: NoteRow[]): Promise<MemoryInjection> {
  const cached = sessionId ? sessionSets.get(sessionId)?.get(toolName) : undefined;
  if (cached) return cached;
  const message = !fitsBudget(prepareNotes(rows)) && sessionId ? await firstUserText(db, sessionId) : "";
  const set = pickNotes(rows, message);
  if (set.notes.length > 0) {
    try {
      await db.update(toolMemories).set({ lastUsedAt: unixNow() }).where(inArray(toolMemories.id, set.notes.map((n) => n.id))).run();
    } catch { /* best-effort */ }
  }
  if (sessionId) {
    let sets = sessionSets.get(sessionId);
    if (!sets) {
      sets = new Map();
      sessionSets.set(sessionId, sets);
      if (sessionSets.size > MAX_SESSIONS) sessionSets.delete(sessionSets.keys().next().value!);
    }
    sets.set(toolName, set);
  }
  return set;
}

export function combineSets(sets: MemoryInjection[]): MemoryInjection {
  const seen = new Set<number>();
  const notes = sets.flatMap((s) => s.notes).filter((n) => !seen.has(n.id) && seen.add(n.id));
  return { notes, omitted: sets.reduce((sum, s) => sum + s.omitted, 0) };
}

/** Test hook: forget every session's set. */
export function clearSessionSets(): void {
  sessionSets.clear();
}
