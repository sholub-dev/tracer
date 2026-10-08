import { eq } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import type { Db } from "../../db/driver.js";
import { memoryOperations, toolMemories } from "../../db/schema.js";
import { CONFIG } from "../../config.js";
import { readAppSettings, writeAppSetting } from "../../db/config-reader.js";
import { normalizeNote, sanitizeNote } from "../../tools/memory-executor.js";
import { runMemoryOptimizer } from "./memory-optimizer.js";

const DAY_SECONDS = 24 * 60 * 60;
const markerKey = (toolName: string) => `memory_optimized:${toolName}`;
const lastRunKey = (toolName: string) => `memory_optimized_at:${toolName}`;

/** Rewrites stored notes the way a new note is written, then removes copies; the oldest row of a group survives on every device. */
export async function cleanupMemories(db: Db): Promise<{ rewritten: number; removed: number }> {
  const rows = await db.select().from(toolMemories).all();
  let rewritten = 0;
  let removed = 0;
  const survivors = new Map<string, { id: number }>();
  const byAge = [...rows].sort((a, b) => a.createdAt - b.createdAt || (a.uid ?? "").localeCompare(b.uid ?? "") || a.id - b.id);
  for (const row of byAge) {
    const note = sanitizeNote(row.note);
    if (note && note !== row.note) {
      await db.update(toolMemories).set({ note }).where(eq(toolMemories.id, row.id)).run();
      rewritten++;
    }
    const key = `${row.toolName}\n${normalizeNote(note || row.note)}`;
    const survivor = survivors.get(key);
    if (!survivor) {
      survivors.set(key, row);
      continue;
    }
    await db.update(memoryOperations).set({ memoryId: survivor.id }).where(eq(memoryOperations.memoryId, row.id)).run();
    await db.delete(toolMemories).where(eq(toolMemories.id, row.id)).run();
    removed++;
  }
  return { rewritten, removed };
}

/** Runs the optimizer for a data source that never ran it or holds more notes than the prompt carries, at most once a day. */
export async function optimizeIfDue(db: Db, toolName: string, now = unixNow(), run = runMemoryOptimizer): Promise<boolean> {
  const count = (await db.select({ id: toolMemories.id }).from(toolMemories).where(eq(toolMemories.toolName, toolName)).all()).length;
  if (count === 0) return false;
  const settings = await readAppSettings(db, [markerKey(toolName), lastRunKey(toolName)]);
  const neverRan = settings[markerKey(toolName)] === undefined;
  const lastRun = Number(settings[lastRunKey(toolName)] ?? 0);
  const overBudget = count > CONFIG.memoryMaxNotes && now - lastRun >= DAY_SECONDS;
  if (!neverRan && !overBudget) return false;
  const result = await run(db, toolName);
  if (!result.success) {
    console.warn(`[memory-maintenance] ${toolName} optimize skipped:`, result.error);
    return false;
  }
  await writeAppSetting(db, markerKey(toolName), true);
  await writeAppSetting(db, lastRunKey(toolName), now);
  return true;
}

/** Background pass at start: cleanup first, then the optimizer for each due data source, one after another. */
export async function maintainMemories(db: Db): Promise<void> {
  try {
    await cleanupMemories(db);
    const names = [...new Set((await db.select({ toolName: toolMemories.toolName }).from(toolMemories).all()).map((r) => r.toolName))];
    for (const name of names) await optimizeIfDue(db, name);
  } catch (err) {
    console.warn("[memory-maintenance] failed:", err);
  }
}
