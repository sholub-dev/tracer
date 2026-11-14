import { fetchText } from "../../lib/fetch-retry.js";

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

interface JiraComment {
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

/** A site subdomain: letters, digits and inner hyphens, so the host stays under atlassian.net. */
export function isJiraDomain(raw: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(normalizeJiraDomain(raw));
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor({ domain, email, apiToken }: JiraClientConfig) {
    if (!isJiraDomain(domain)) throw new Error("The Jira domain is invalid");
    this.baseUrl = `https://${normalizeJiraDomain(domain)}.atlassian.net`;
    // btoa takes Latin-1 only, so encode to UTF-8 bytes first.
    const bytes = new TextEncoder().encode(`${email}:${apiToken}`);
    this.authHeader = "Basic " + btoa(String.fromCharCode(...bytes));
  }

  private async request(path: string, init?: RequestInit): Promise<string> {
    const res = await fetchText(`${this.baseUrl}${path}`, {
      ...init,
      // The Authorization header must not follow a redirect to another host.
      redirect: "error",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    }, { timeoutMs: 15_000, retry: !init?.method || init.method === "GET" });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${res.text.slice(0, 300) || res.statusText}`);
    return res.text;
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
    const text = await this.request(
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${ISSUE_FIELDS}`,
    );
    const data = JSON.parse(text) as {
      key?: string;
      fields?: {
        summary?: string;
        description?: string | null;
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
            body?: string;
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
      description: f.description ?? null,
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
        body: c.body ?? null,
        created: c.created ?? null,
      })),
    };
  }

  /** Post a single plain-text comment to an issue. The only write operation. */
  async addComment(key: string, body: string): Promise<{ id: string | null; url: string }> {
    const text = await this.request(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    let id: string | null = null;
    try { id = (JSON.parse(text) as { id?: string }).id ?? null; } catch { /* the comment is posted; only its link is lost */ }
    return {
      id,
      url: id
        ? `${this.baseUrl}/browse/${encodeURIComponent(key)}?focusedCommentId=${id}`
        : `${this.baseUrl}/browse/${encodeURIComponent(key)}`,
    };
  }
}
