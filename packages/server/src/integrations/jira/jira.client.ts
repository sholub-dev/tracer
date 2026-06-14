/**
 * Jira Cloud REST API v2 client. v2 is used (not v3) so issue descriptions and
 * comment bodies are plain-text/wiki strings — no Atlassian Document Format (ADF) JSON.
 */

export interface JiraIssue {
  key: string;
  summary: string;
  description: string | null;
  status: string;
}

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

  async getIssue(key: string): Promise<JiraIssue> {
    const res = await this.request(
      `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,status`,
    );
    const data = (await res.json()) as {
      key?: string;
      fields?: {
        summary?: string;
        description?: unknown;
        status?: { name?: string };
      };
    };
    const fields = data.fields ?? {};
    return {
      key: data.key ?? key,
      summary: fields.summary ?? "",
      description: toPlainText(fields.description),
      status: fields.status?.name ?? "Unknown",
    };
  }

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
