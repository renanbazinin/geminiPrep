import type { SpecialGroupConfig } from "./config.js";

// The only way this app talks to Jira. It is read-only by construction:
//  - `get()` always sends GET, and only to the allow-listed read endpoints below.
//  - `searchJql()` is the single POST, to Jira's search endpoint (JQL goes in the body; nothing is changed).
// There is no generic request method, so no caller can create, edit, or delete anything.

const READ_ENDPOINTS: RegExp[] = [
  /^\/rest\/api\/3\/myself$/,
  /^\/rest\/api\/3\/project\/search\?/,
  /^\/rest\/api\/3\/project\/[A-Z][A-Z0-9_]*$/,
  /^\/rest\/api\/3\/project\/[A-Z][A-Z0-9_]*\/(components|versions)$/,
  /^\/rest\/api\/3\/issue\/createmeta\/[A-Z][A-Z0-9_]*\/issuetypes(\/\d+)?\?/,
  /^\/rest\/api\/3\/priority\/search\?/,
  /^\/rest\/api\/3\/field$/,
  /^\/rest\/api\/3\/issue\/[A-Z][A-Z0-9_]*-\d+\?/,
  /^\/rest\/api\/3\/user\/search\?/,
];
const SEARCH_PATH = "/rest/api/3/search/jql";

export function isAllowedReadPath(path: string): boolean {
  return READ_ENDPOINTS.some(pattern => pattern.test(path));
}

export class ReadOnlyJiraClient {
  constructor(readonly config: SpecialGroupConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  get<T = any>(path: string): Promise<T> {
    if (!isAllowedReadPath(path)) throw new Error(`Blocked: ${path.split("?")[0]} is not an allowed read endpoint.`);
    return this.send<T>(path, { method: "GET" });
  }

  searchJql<T = any>(body: { jql: string; fields: string[]; maxResults: number; nextPageToken?: string }): Promise<T> {
    return this.send<T>(SEARCH_PATH, { method: "POST", body: JSON.stringify(body) });
  }

  private async send<T>(path: string, init: { method: "GET" | "POST"; body?: string }): Promise<T> {
    const { baseUrl, email, token } = this.config;
    if (!token) throw new Error("The Special Group app is not connected to Jira yet. Use Connect on the page.");
    let response: Response;
    try {
      response = await this.fetchImpl(baseUrl + path, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    } catch {
      throw new Error("Jira could not be reached. Try again.");
    }
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const details = [...(Array.isArray(data.errorMessages) ? data.errorMessages : []), ...Object.values(data.errors ?? {})]
        .filter(value => typeof value === "string").join(" ").slice(0, 400);
      const hint = response.status === 401 ? "Authentication rejected. Check the email, the full token, and the 'scoped token' setting."
        : response.status === 403 ? "The token lacks permission or scope for this read."
        : response.status === 404 ? "Not found, or not visible to this account."
        : response.status === 429 ? "Rate limited. Wait a moment." : details;
      throw new Error(`Jira HTTP ${response.status}. ${hint}`.replaceAll(token, "[REDACTED]"));
    }
    return data as T;
  }
}
