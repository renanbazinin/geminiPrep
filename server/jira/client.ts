import fs from "node:fs";
import { parse } from "dotenv";
import { JIRA_TEAM, type JiraIssue } from "../../shared/jira.js";

export function jiraConfig() {
  const local = { ...(fs.existsSync(".env") ? parse(fs.readFileSync(".env")) : {}),
    ...(fs.existsSync(".env.jira.local") ? parse(fs.readFileSync(".env.jira.local")) : {}) };
  const value = (key: string, fallback = "") => local[key] || process.env[key] || fallback;
  const siteUrl = value("JIRA_SITE_URL", "https://renanbazinin2.atlassian.net").replace(/\/$/, "");
  const baseUrl = value("JIRA_API_BASE_URL", "https://api.atlassian.com/ex/jira/56d7178f-a215-4681-8587-2b391744df0d").replace(/\/$/, "");
  const email = value("JIRA_EMAIL", "renabazinin2@gmail.com");
  const token = value("JIRA_API_TOKEN");
  const projectKey = value("JIRA_PROJECT_KEY", "DESK");
  if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(siteUrl)
    || !(baseUrl === siteUrl || /^https:\/\/api\.atlassian\.com\/ex\/jira\/[a-z0-9-]+$/i.test(baseUrl))
    || !/^[A-Z][A-Z0-9_]*$/.test(projectKey)) throw new Error("Invalid server-side Jira connection settings.");
  return { siteUrl, baseUrl, email, token, projectKey };
}

export function plainText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: string; content?: unknown[]; type?: string };
  return (node.text ?? "") + (node.content?.map(plainText).join(node.type === "doc" ? "\n" : "") ?? "");
}
export function adf(text: string) {
  return { type: "doc", version: 1, content: text.split("\n").map(line => ({
    type: "paragraph", content: line ? [{ type: "text", text: line }] : [],
  })) };
}
export function textArg(args: Record<string, unknown>, name: string, required = false, max = 12000): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}.`);
  return value.trim();
}
function jql(value: string) { return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
export function ownerFor(name: string) {
  const owner = JIRA_TEAM.find(member => member.name.toLowerCase() === name.toLowerCase());
  if (!owner) throw new Error("Owner must be Renan, Dana, Bobo, or Koko (simulated demo ownership).");
  return owner;
}

export class JiraClient {
  constructor(readonly config = jiraConfig(), private readonly fetchImpl = fetch) {}

  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    if (!this.config.token) throw new Error("Add JIRA_API_TOKEN to the server's .env file to connect Jira.");
    if (!path.startsWith("/rest/api/3/")) throw new Error("Unsupported Jira endpoint.");
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.baseUrl + path, {
        method, redirect: "error", signal: AbortSignal.timeout(25000),
        headers: { Authorization: `Basic ${Buffer.from(`${this.config.email}:${this.config.token}`).toString("base64")}`,
          Accept: "application/json", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(method === "GET" ? "Jira could not be reached. Try refreshing." :
        "Jira request outcome is uncertain. Check the board before repeating any change.");
    }
    if (response.status === 204) return {};
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = [...(Array.isArray(data.errorMessages) ? data.errorMessages : []),
        ...Object.values(data.errors ?? {})].filter(v => typeof v === "string").join(" ").slice(0, 600);
      const hint = response.status === 401 ? "Authentication rejected. Paste the complete API token (not its name), verify the Atlassian email, and check whether it was created with scopes. New tokens may take a minute to activate." :
        response.status === 403 ? "Check Jira permissions and token scopes." :
        response.status === 429 ? "Rate limit reached. Wait before trying again." : details;
      throw new Error(`Jira HTTP ${response.status}. ${hint}`.replaceAll(this.config.token, "[REDACTED]"));
    }
    return data;
  }

  private key(key: string) {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !key.startsWith(this.config.projectKey + "-"))
      throw new Error(`Only ${this.config.projectKey} tickets are allowed in this space.`);
    return key;
  }

  normalize(issue: any): JiraIssue {
    this.key(issue.key);
    const f = issue.fields ?? {};
    if (f.project?.key !== this.config.projectKey) throw new Error("Jira returned a ticket outside the configured project.");
    const labels: string[] = Array.isArray(f.labels) ? f.labels : [];
    return { key: issue.key, summary: f.summary ?? "", description: plainText(f.description).slice(0, 16000),
      status: f.status?.name ?? "Unknown", type: f.issuetype?.name ?? "Task",
      owner: JIRA_TEAM.find(member => labels.includes(member.label))?.name ?? null,
      assignee: f.assignee?.displayName ?? null, labels, updated: f.updated ?? "",
      url: `${this.config.siteUrl}/browse/${issue.key}` };
  }

  async get(key: string): Promise<JiraIssue> {
    return this.normalize(await this.request(`/rest/api/3/issue/${this.key(key)}?fields=summary,description,status,issuetype,labels,assignee,updated,project`));
  }

  async search(args: Record<string, unknown> = {}) {
    const filters = [`project = ${jql(this.config.projectKey)}`];
    const owner = textArg(args, "owner", false, 50);
    const status = textArg(args, "status", false, 100);
    const type = textArg(args, "type", false, 50);
    const text = textArg(args, "text", false, 120);
    if (owner) filters.push(`labels = ${jql(ownerFor(owner).label)}`);
    if (status) filters.push(`status = ${jql(status)}`);
    if (type) filters.push(`issuetype = ${jql(type)}`);
    if (text) filters.push(`text ~ ${jql(text)}`);
    if (args.openOnly === true) filters.push("statusCategory != Done");
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    let pages = 0;
    do {
      const data = await this.request("/rest/api/3/search/jql", "POST", {
        jql: filters.join(" AND ") + " ORDER BY updated DESC", maxResults: 50,
        fields: ["summary", "description", "status", "issuetype", "labels", "assignee", "updated", "project"],
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      issues.push(...(data.issues ?? []).map((issue: unknown) => this.normalize(issue)));
      pages++;
      nextPageToken = data.isLast === true ? undefined : data.nextPageToken;
    } while (nextPageToken && issues.length < 200 && pages < 4);
    return { issues, truncated: Boolean(nextPageToken), fetchedAt: new Date().toISOString() };
  }

  async create(args: Record<string, unknown>) {
    const summary = textArg(args, "summary", true, 255)!;
    const description = textArg(args, "description", true)!;
    const type = textArg(args, "type", false, 50) ?? "Task";
    const owner = textArg(args, "owner", false, 50);
    const labels = ["chatbot-demo", ...(owner ? [ownerFor(owner).label] : [])];
    let typeId: string | undefined;
    for (let startAt = 0; startAt < 500; startAt += 50) {
      const page = await this.request(`/rest/api/3/issue/createmeta/${this.config.projectKey}/issuetypes?startAt=${startAt}&maxResults=50`);
      typeId = page.issueTypes?.find((item: any) => item.name.toLowerCase() === type.toLowerCase() && !item.subtask)?.id;
      if (typeId || page.isLast || !page.issueTypes?.length) break;
    }
    if (!typeId) throw new Error(`Work type ${type} is not available for creation in this project.`);
    const result = await this.request("/rest/api/3/issue", "POST", { fields: {
      project: { key: this.config.projectKey }, issuetype: { id: typeId }, summary, description: adf(description), labels,
    } });
    return this.afterWrite(result.key, "Created");
  }

  private async afterWrite(key: string, action: string) {
    // A failed read-back must never make the model retry a successful write.
    try { return { saved: true, action, issue: await this.get(key) }; }
    catch { return { saved: true, action, key, url: `${this.config.siteUrl}/browse/${key}`, warning: "Saved; read-back failed. Refresh the board to verify details." }; }
  }

  async update(args: Record<string, unknown>) {
    const key = textArg(args, "key", true, 40)!;
    const current = await this.get(key);
    const summary = textArg(args, "summary", false, 255);
    const description = textArg(args, "description");
    const owner = textArg(args, "owner", false, 50);
    const fields: Record<string, unknown> = {};
    if (summary) fields.summary = summary;
    if (description) fields.description = adf(description);
    const labelUpdates = owner ? [...current.labels.filter(label => label.startsWith("demo-owner-")).map(remove => ({ remove })), { add: ownerFor(owner).label }] : [];
    if (!Object.keys(fields).length && !labelUpdates.length) throw new Error("Provide a summary, description, or demo owner to update.");
    await this.request(`/rest/api/3/issue/${key}`, "PUT", { fields, ...(labelUpdates.length ? { update: { labels: labelUpdates } } : {}) });
    return this.afterWrite(key, "Updated");
  }

  async transitions(key: string) {
    await this.get(key);
    const result = await this.request(`/rest/api/3/issue/${key}/transitions`);
    return { transitions: result.transitions.map((t: any) => ({ id: t.id, name: t.name, status: t.to?.name })) };
  }

  async transition(args: Record<string, unknown>) {
    const key = textArg(args, "key", true, 40)!;
    const status = textArg(args, "status", true, 100)!;
    const current = await this.get(key);
    if (current.status.toLowerCase() === status.toLowerCase()) return { saved: false, message: "Already in this status.", issue: current };
    const options = await this.transitions(key);
    const matches = options.transitions.filter((t: any) => t.status?.toLowerCase() === status.toLowerCase());
    if (matches.length !== 1) throw new Error(`No unambiguous transition to ${status}. Available: ${options.transitions.map((t: any) => t.status).join(", ")}`);
    await this.request(`/rest/api/3/issue/${key}/transitions`, "POST", { transition: { id: matches[0].id } });
    return this.afterWrite(key, "Status changed");
  }

  async comment(args: Record<string, unknown>) {
    const key = textArg(args, "key", true, 40)!;
    const text = textArg(args, "text", true)!;
    await this.get(key);
    const result = await this.request(`/rest/api/3/issue/${key}/comment`, "POST", { body: adf(text) });
    return { saved: true, key, commentId: result.id, url: `${this.config.siteUrl}/browse/${key}` };
  }
}
