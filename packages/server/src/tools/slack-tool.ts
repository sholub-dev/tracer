import { z } from "zod";
import { tool, type Tool } from "ai";
import type { Db } from "../db/driver.js";
import { messagePost, postSlack, readSlackConfig, redact } from "../integrations/slack.js";
import { SLACK_RULE } from "../monitors/alert-summary.js";

type SlackResult = { posted: true; clipped?: string; redacted?: string } | { error: string };

export const SLACK_PROMPT_FRAGMENT = `## Slack
You can post to the team's Slack channel with post_slack_message.
- Use it when the user asks for a post, or when you judge that a post helps the team.
- In an alert investigation, report_alert_summary already posts the alert summary. Do not post the same summary again.`;

// Spacing and empty parentheses that redact tidies are not a removal.
const bare = (s: string) => s.replace(/[\s()]/g, "");

export function postSlackMessageTool(db: Db): Tool<{ text: string }, SlackResult> {
  return tool({
    description: "Post a message to the team's Slack channel. Use it when the user asks you to post, or when you judge that a post helps the team. "
      + "In an alert investigation, report_alert_summary already posts the alert summary: do not post the same summary twice. "
      + "Write plain text for a reader who sees nothing else. " + SLACK_RULE,
    inputSchema: z.object({ text: z.string().describe("The message to post") }),
    execute: async ({ text }) => {
      const config = await readSlackConfig(db);
      if (!config) return { error: "Slack is not configured" };
      const payload = messagePost(text);
      if (!payload) return { error: "The message is empty" };
      const result = await postSlack(config.webhookUrl, payload);
      if ("error" in result) return result;
      return {
        posted: true,
        // Tells the agent the post differs from what it wrote, so it does not claim a link or id went out.
        ...(bare(redact(text)) !== bare(text) && { redacted: "Links, emails, ids and long digit runs were removed or masked. The post carries none of them." }),
        ...(payload.text.endsWith(" …") && { clipped: "The text was cut at 2900 characters. The post is shorter than the message." }),
      };
    },
  });
}
