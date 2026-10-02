import type { ReactNode } from "react";
import { Note, NoteLink } from "./parts";

const Strong = ({ children }: { children: ReactNode }) => <span className="font-medium text-foreground">{children}</span>;

function CanDo({ children }: { children: ReactNode }) {
  return (
    <div>
      <Strong>What Tracer can do with it</Strong>
      <ul className="mt-1 ml-4 list-disc space-y-0.5">{children}</ul>
    </div>
  );
}

export const GOOGLE_AI_NOTE = (
  <Note>
    <div>
      Create a Gemini API key at <NoteLink href="https://aistudio.google.com/api-keys" />
    </div>
    <div className="text-muted-foreground">
      This key powers the Gemini models Tracer uses to run chats and analyze your data. It is the model provider, not a
      data source. Tracer sends your prompts and the data it has already fetched to Google's Gemini API for inference; it
      grants no access back into your Google account.
    </div>
  </Note>
);

export const PROVIDER_NOTES: Record<string, ReactNode> = {
  newrelic: (
    <Note>
      <div>
        Create a <Strong>User key</Strong> at <NoteLink href="https://one.newrelic.com/admin-portal/api-keys/home" />.
        Your numeric Account ID is shown on the same page.
      </div>
      <CanDo>
        <li>
          <Strong>Run read-only NRQL queries</Strong> against your account, to inspect metrics, logs, traces and errors
          while investigating.
        </li>
      </CanDo>
      <div className="text-muted-foreground">
        It only reads via NRQL. It cannot write, modify, deploy or delete anything. A New Relic User key inherits your
        role, so for least privilege use a user scoped to read-only access.
      </div>
    </Note>
  ),
  posthog: (
    <Note>
      <div>
        Create a <Strong>Personal API key</Strong> in your PostHog instance at{" "}
        <span className="font-mono">/settings/user-api-keys</span>. Grant it the single scope{" "}
        <Strong>Query → Read</Strong>. The Project ID is in Settings → Project. Set Host only if you are not on US cloud
        (e.g. <span className="font-mono">eu.posthog.com</span> or a self-hosted URL).
      </div>
      <CanDo>
        <li>
          <Strong>Run read-only HogQL queries</Strong> against the project, to inspect events, persons and analytics while
          investigating.
        </li>
      </CanDo>
      <div className="text-muted-foreground">
        With only the <Strong>Query → Read</Strong> scope it cannot create, modify or delete anything in PostHog, and it
        reaches only the project you configure.
      </div>
    </Note>
  ),
};

export const JIRA_NOTE = (
  <Note>
    <div>
      Create a token (use the plain <Strong>Create API token</Strong>, not "with scopes") at{" "}
      <NoteLink href="https://id.atlassian.com/manage-profile/security/api-tokens" />
    </div>
    <CanDo>
      <li>
        <Strong>Read an issue</Strong>: summary, description, status, type, priority, assignee, reporter, labels,
        components, fix versions, resolution, dates and its comment thread
      </li>
      <li>
        <Strong>Post a comment</Strong>: plain text, only when you ask
      </li>
    </CanDo>
    <div className="text-muted-foreground">
      It cannot edit, transition, delete, bulk-read or administer anything else. The token uses its account's
      permissions, so for least privilege point it at a Jira account limited to the projects Tracer should touch.
    </div>
  </Note>
);

export const SLACK_NOTE = (
  <Note>
    <div>
      At <NoteLink href="https://api.slack.com/apps" />: <Strong>Create New App</Strong> (from scratch), then{" "}
      <Strong>Incoming Webhooks</Strong>, turn it on, <Strong>Add New Webhook</Strong>, pick a channel and copy the URL.
    </div>
    <div className="text-muted-foreground">
      Saving posts a test message. When a monitor fires and its investigation finishes, Tracer posts what it found: the
      severity and a one-line root cause of the issue, then the monitor that found it. Repeats and firings with Alert off
      are not posted. Everyone in the channel sees these findings, so pick a channel with the right access. Emails, phone
      numbers and long numbers are masked.
    </div>
    <div className="text-muted-foreground">
      Tags need Slack member IDs, not names: open the profile, then More (...), then <Strong>Copy member ID</Strong> (e.g.
      U0123ABCD). Separate several with commas.
    </div>
  </Note>
);
