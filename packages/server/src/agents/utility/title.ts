import { generateText } from "ai";
import { eq } from "drizzle-orm";
import { unixNow } from "@oko/shared";
import { chatSessions } from "../../db/schema.js";
import { resolveUtilityModel } from "../../llm/resolve.js";
import { extractUsage, recordAgentRun } from "../../llm/usage.js";
import type { Db } from "../../db/client.js";

export function generateSessionTitle(db: Db, sessionId: string, userMessage: string): Promise<string | null> {
  const resolved = resolveUtilityModel(db);
  if ("error" in resolved) {
    console.warn("[title] Cannot generate title:", resolved.error);
    return Promise.resolve(null);
  }

  return generateText({
    model: resolved.model,
    temperature: 0,
    system: "Generate a short title (3-8 words) for the user's request. Preserve any IDs, error names, service names, or specific identifiers from the message — these make the title useful. Focus on WHAT is being asked, not how. Output only the title, nothing else.",
    messages: [{ role: "user", content: userMessage }],
  })
    .then(({ text, usage }) => {
      const u = extractUsage(usage, resolved.modelId);
      const title = text.trim().slice(0, 80);
      if (title) {
        recordAgentRun(db, {
          sessionId,
          agentType: "title",
          model: resolved.modelId,
          usage: u,
        });
        db.update(chatSessions)
          .set({ title, updatedAt: unixNow() })
          .where(eq(chatSessions.id, sessionId))
          .run();
        return title;
      }
      return null;
    })
    .catch((err) => {
      console.warn("[title] Failed to generate title:", err);
      return null;
    });
}
