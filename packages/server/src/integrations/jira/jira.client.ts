/**
 * Jira Cloud REST API v2 client using a classic Atlassian API token over HTTP
 * Basic auth against the site host. v2 (not v3) keeps issue descriptions and
 * comment bodies as plain-text/wiki strings — no Atlassian Document Format (ADF).
 *
 * Least privilege by design: a classic API token inherits the owning account's
 * full Jira permissions, so the safety boundary is enforced HERE, in code. This
 * client deliberately exposes only three operations — validate (read current
 * user), getIssue (read one issue's details and comments), and addComment
 * (post one plain-text comment). There are intentionally NO methods to edit,
 * transition, delete, bulk-read, or administer anything, and the chat layer
 * surfaces only the read-issue and add-comment tools. The agent therefore cannot
 * perform any Jira action beyond those two, regardless of what the token could
 * technically do. For defense in depth, point it at a dedicated Jira account whose
 * permissions are restricted to the project(s) Tracer should touch.
 */

export interface JiraComment {
  id: string | null;
  author: string | null;
  body: string | null;
  created: string | null;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: string | null;
  status: string;
  issueType: string | null;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  /** Jira "labels" — the tag-style field. */
  labels: string[];
  components: string[];
  fixVersions: string[];
  created: string | null;
  updated: string | null;
  dueDate: string | null;
  resolution: string | null;
  /** Comments embedded in the issue fetch, oldest first. Bounded by Jira's
   *  page size for the embedded `comment` field, so very long threads may be
   *  truncated to the most recent page. */
  comments: JiraComment[];
}

/** Issue fields fetched for getIssue — the common Jira "Details" right-panel set
 *  plus the embedded comment thread. */
const ISSUE_FIELDS =
  "summary,description,status,issuetype,priority,assignee,reporter,labels,components,fixVersions,created,updated,duedate,resolution,comment";

export interface JiraClientConfig {
  domain: string;
  email: string;
  apiToken: string;
}

/**
 * Reduce user-entered domain input to the bare site subdomain, tolerating a
 * pasted protocol, a full `*.atlassian.net` host, trailing slashes, or whitespace.
 */
export function normalizeJiraDomain(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.atlassian\.net$/i, "");
}

/**
 * Jira Cloud REST v2 returns descriptions as plain/wiki strings, but defensively
 * flatten an Atlassian Document Format (ADF) node tree to text if one shows up.
 */
function toPlainText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === "string") parts.push(n.text);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(value);
  return parts.join("") || null;
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor({ domain, email, apiToken }: JiraClientConfig) {
    this.baseUrl = `https://${normalizeJiraDomain(domain)}.atlassian.net`;
    this.authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Jira ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }
    return res;
  }

  /** Validate credentials by fetching the current user. */
  async validate(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request("/rest/api/2/myself");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Read a single issue's details (summary, description, status, and the Details
   *  panel fields: type, priority, assignee, reporter, labels, etc.) plus its
   *  comment thread. Read-only. */
  async getIssue(key: string): Promise<JiraIssue> {
    const res = await this.request(
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
    );
    const data = (await res.json()) as {
      key?: string;
      fields?: {
        summary?: string;
        description?: unknown;
        status?: { name?: string };
        issuetype?: { name?: string };
        priority?: { name?: string };
        assignee?: { displayName?: string } | null;
        reporter?: { displayName?: string } | null;
        labels?: string[];
        components?: Array<{ name?: string }>;
        fixVersions?: Array<{ name?: string }>;
        created?: string;
        updated?: string;
        duedate?: string | null;
        resolution?: { name?: string } | null;
        comment?: {
          comments?: Array<{
            id?: string;
            author?: { displayName?: string } | null;
            body?: unknown;
            created?: string;
          }>;
        };
      };
    };
    const f = data.fields ?? {};
    const names = (arr?: Array<{ name?: string }>): string[] =>
      (arr ?? []).map((x) => x.name).filter((n): n is string => !!n);
    return {
      key: data.key ?? key,
      summary: f.summary ?? "",
      description: toPlainText(f.description),
      status: f.status?.name ?? "Unknown",
      issueType: f.issuetype?.name ?? null,
      priority: f.priority?.name ?? null,
      assignee: f.assignee?.displayName ?? null,
      reporter: f.reporter?.displayName ?? null,
      labels: f.labels ?? [],
      components: names(f.components),
      fixVersions: names(f.fixVersions),
      created: f.created ?? null,
      updated: f.updated ?? null,
      dueDate: f.duedate ?? null,
      resolution: f.resolution?.name ?? null,
      comments: (f.comment?.comments ?? []).map((c) => ({
        id: c.id ?? null,
        author: c.author?.displayName ?? null,
        body: toPlainText(c.body),
        created: c.created ?? null,
      })),
    };
  }

  /** Post a single plain-text comment to an issue. The only write operation. */
  async addComment(key: string, body: string): Promise<{ id: string | null; url: string }> {
    const res = await this.request(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    const id = data.id ?? null;
    return {
      id,
      url: id
        ? `${this.baseUrl}/browse/${key}?focusedCommentId=${id}`
        : `${this.baseUrl}/browse/${key}`,
    };
  }
}
