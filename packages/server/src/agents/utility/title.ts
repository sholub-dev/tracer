import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { unixNow } from "@tracer-sh/shared";
import { chatSessions } from "../../db/schema.js";
import { CONFIG } from "../../config.js";
import { resolveModel, utilityProviderOptions } from "../../llm/resolve.js";
import { recordEachCall } from "../../llm/usage.js";
import type { Db } from "../../db/driver.js";
import { sessionChanged } from "../../lib/session-events.js";
import { timeoutSignal } from "../../lib/timeout-signal.js";

export async function generateSessionTitle(db: Db, sessionId: string, userMessage: string): Promise<string | null> {
  try {
    const resolved = await resolveModel(db);
    if ("error" in resolved) {
      console.warn("[title] Cannot generate title:", resolved.error);
      return null;
    }

    const { text } = await generateText({
      model: resolved.model,
      temperature: 0,
      providerOptions: utilityProviderOptions(resolved),
      instructions: "Generate a short title (3-8 words) for the user's request. Preserve any IDs, error names, service names, or specific identifiers from the message — these make the title useful. Focus on WHAT is being asked, not how. Output only the title, nothing else.",
      messages: [{ role: "user", content: userMessage }],
      abortSignal: timeoutSignal(CONFIG.utilityCallTimeoutMs),
      onLanguageModelCallEnd: recordEachCall(db, sessionId, "title", resolved.modelId),
    });
    const title = text.trim().slice(0, 80);
    if (title) {
      await db.update(chatSessions)
        .set({ title, updatedAt: unixNow() })
        .where(eq(chatSessions.id, sessionId))
        .run();
      sessionChanged(sessionId);
      return title;
    }
    return null;
  } catch (err) {
    console.warn("[title] Failed to generate title:", err);
    return null;
  }
}
