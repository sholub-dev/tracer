/**
 * Jira chat tools. Contributed to every chat session (independent of the active
 * observability provider) when Jira is configured.
 */

import { z } from "zod";
import { tool } from "ai";
import type { Db } from "../../db/client.js";
import { JiraClient } from "./jira.client.js";
import { readJiraConfig } from "./config.js";

const JIRA_PROMPT_FRAGMENT = `## Jira
You can read Jira issues and post comments via the jira tools.
- Use get_jira_issue when the user references a ticket key (LETTERS-NUMBER, e.g. PROJ-123) or asks what a ticket says.
- Use add_jira_comment ONLY when the user explicitly asks to comment on, post to, or update a ticket. Never post proactively or as a side effect of analysis.
- Before posting, show the exact comment text and target issue key. Comment bodies are plain text. Report the resulting comment URL on success.`;

export function getJiraChatTools(
  db: Db,
): { tools: Record<string, unknown>; promptFragment: string } | null {
  const config = readJiraConfig(db);
  if (!config) return null;

  const client = new JiraClient(config);

  const tools: Record<string, unknown> = {
    get_jira_issue: tool({
      description:
        "Read a Jira issue's details by its issue key (e.g. PROJ-123): summary, description, status, type, priority, assignee, reporter, labels, components, fix versions, resolution, created/updated/due dates, and its comment thread.",
      inputSchema: z.object({
        issueKey: z.string().describe("Jira issue key, e.g. PROJ-123"),
      }),
      execute: async ({ issueKey }) => {
        try {
          return { issue: await client.getIssue(issueKey) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
    add_jira_comment: tool({
      description:
        "Post a plain-text comment to a Jira issue. Only call when the user explicitly asks to comment on or update a ticket.",
      inputSchema: z.object({
        issueKey: z.string().describe("Jira issue key, e.g. PROJ-123"),
        body: z.string().min(1).describe("Plain-text comment body"),
      }),
      execute: async ({ issueKey, body }) => {
        try {
          const result = await client.addComment(issueKey, body);
          return { posted: true, commentId: result.id, url: result.url };
        } catch (err) {
          return { posted: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),
  };

  return { tools, promptFragment: JIRA_PROMPT_FRAGMENT };
}
