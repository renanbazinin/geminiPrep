import type { JiraPerson, ParentParam, ProjectOptions, ProjectSummary } from "../../shared/special-group/types.js";
import { plainText } from "../jira/client.js";
import type { ReadOnlyJiraClient } from "./read-only-client.js";

// Domain-level reads: "what projects, work types, epics, people... exist?"
// Every function takes the read-only client, so these can never change Jira.

const KEY = /^[A-Z][A-Z0-9_]*$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const OPTIONS_TTL_MS = 2 * 60 * 1000;
const optionsCache = new Map<string, { expires: number; value: ProjectOptions }>();

export function projectKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!KEY.test(key)) throw new Error("A valid project key is required, for example DESK.");
  return key;
}
export function issueKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!ISSUE_KEY.test(key)) throw new Error("A valid work item key is required, for example DESK-12.");
  return key;
}
/** JQL string literal with quotes and backslashes escaped. */
export function jqlString(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
const optional = async <T>(read: () => Promise<T>, fallback: T) => { try { return await read(); } catch { return fallback; } };

export async function listProjects(client: ReadOnlyJiraClient, query = ""): Promise<ProjectSummary[]> {
  const params = new URLSearchParams({ maxResults: "50", orderBy: "name", ...(query.trim() ? { query: query.trim().slice(0, 80) } : {}) });
  const data = await client.get(`/rest/api/3/project/search?${params}`);
  return (data.values ?? []).map((p: any) => ({ id: String(p.id), key: p.key, name: p.name }));
}

/**
 * Company-managed projects take the epic through the "Epic Link" custom field;
 * team-managed projects use the standard parent field.
 */
async function detectParentParam(client: ReadOnlyJiraClient, style: string): Promise<ParentParam> {
  if (style === "next-gen") return { name: "parent", mode: "parent" };
  const fields = await optional(() => client.get<any[]>("/rest/api/3/field"), []);
  const epicLink = fields.find(field => field.schema?.custom === "com.pyxis.greenhopper.jira:gh-epic-link");
  return epicLink ? { name: String(epicLink.id), mode: "epic-link" } : null;
}

export async function getProjectOptions(client: ReadOnlyJiraClient, rawKey: string, cache: { fresh?: boolean; now?: number } = {}): Promise<ProjectOptions> {
  const key = projectKey(rawKey);
  const now = cache.now ?? Date.now();
  const cacheKey = `${client.config.baseUrl}|${key}`;
  const cached = optionsCache.get(cacheKey);
  if (cached && cached.expires > now && !cache.fresh) return cached.value;

  const project = await client.get(`/rest/api/3/project/${key}`);
  const style = String(project.style ?? "classic");
  const createTypes = await optional(() => client.get(`/rest/api/3/issue/createmeta/${key}/issuetypes?maxResults=50`), null);
  const rawTypes: any[] = createTypes?.issueTypes ?? createTypes?.values ?? project.issueTypes ?? [];
  const epicTypeNames = (project.issueTypes ?? rawTypes).filter((t: any) => t.hierarchyLevel === 1).map((t: any) => t.name as string);
  const [priorities, components, versions, epics, parentParam] = await Promise.all([
    optional(async () => (await client.get("/rest/api/3/priority/search?maxResults=50")).values ?? [], []),
    optional(() => client.get<any[]>(`/rest/api/3/project/${key}/components`), []),
    optional(() => client.get<any[]>(`/rest/api/3/project/${key}/versions`), []),
    epicTypeNames.length ? optional(async () => (await client.searchJql({
      jql: `project = ${jqlString(key)} AND issuetype in (${epicTypeNames.map(jqlString).join(", ")}) AND statusCategory != Done ORDER BY updated DESC`,
      fields: ["summary", "status"], maxResults: 50,
    })).issues ?? [], []) : Promise.resolve([]),
    detectParentParam(client, style),
  ]);
  const value: ProjectOptions = {
    project: { id: String(project.id), key: project.key, name: project.name, style },
    issueTypes: rawTypes.map(t => ({ id: String(t.id), name: t.name, subtask: Boolean(t.subtask) })),
    priorities: priorities.map((p: any) => ({ id: String(p.id), name: p.name })),
    components: components.map((c: any) => ({ id: String(c.id), name: c.name })),
    versions: versions.filter((v: any) => !v.archived && !v.released).map((v: any) => ({ id: String(v.id), name: v.name })),
    epics: epics.map((e: any) => ({ key: e.key, summary: e.fields?.summary ?? "", status: e.fields?.status?.name ?? "" })),
    parentParam,
  };
  optionsCache.set(cacheKey, { expires: now + OPTIONS_TTL_MS, value });
  return value;
}

export function clearProjectOptionsCache() { optionsCache.clear(); screenCache.clear(); }

export type ScreenField = { fieldId: string; name: string; required: boolean };
const screenCache = new Map<string, { expires: number; value: ScreenField[] }>();

/** Fields on one work type's create screen. The create link can only prefill fields listed here. */
export async function getCreateScreenFields(client: ReadOnlyJiraClient, rawKey: string, typeId: string, now = Date.now()): Promise<ScreenField[]> {
  const key = projectKey(rawKey);
  if (!/^\d{1,18}$/.test(typeId)) throw new Error("A valid work type ID is required.");
  const cacheKey = `${client.config.baseUrl}|${key}|${typeId}`;
  const cached = screenCache.get(cacheKey);
  if (cached && cached.expires > now) return cached.value;
  const fields: ScreenField[] = [];
  for (let startAt = 0; startAt < 1000; startAt += 100) {
    const page = await client.get(`/rest/api/3/issue/createmeta/${key}/issuetypes/${typeId}?startAt=${startAt}&maxResults=100`);
    const batch: any[] = page.fields ?? page.results ?? page.values ?? [];
    fields.push(...batch.map(f => ({ fieldId: String(f.fieldId ?? f.key), name: String(f.name ?? f.fieldId), required: Boolean(f.required) })));
    if (!batch.length || page.isLast || startAt + batch.length >= Number(page.total ?? 0)) break;
  }
  screenCache.set(cacheKey, { expires: now + OPTIONS_TTL_MS, value: fields });
  return fields;
}

/** Field IDs for the draft's work type, or null when unknown (then the link includes every field). */
export async function screenFieldIds(client: ReadOnlyJiraClient, draft: { project?: { key: string }; issueType?: { id: string } }) {
  if (!draft.project || !draft.issueType) return null;
  return getCreateScreenFields(client, draft.project.key, draft.issueType.id).then(fields => fields.map(f => f.fieldId)).catch(() => null);
}

export async function searchIssues(client: ReadOnlyJiraClient, args: { projectKey: string; text?: string; type?: string; openOnly?: boolean }) {
  const filters = [`project = ${jqlString(projectKey(args.projectKey))}`];
  if (args.text?.trim()) filters.push(`text ~ ${jqlString(args.text.trim().slice(0, 120))}`);
  if (args.type?.trim()) filters.push(`issuetype = ${jqlString(args.type.trim().slice(0, 60))}`);
  if (args.openOnly) filters.push("statusCategory != Done");
  const data = await client.searchJql({
    jql: `${filters.join(" AND ")} ORDER BY updated DESC`, maxResults: 20,
    fields: ["summary", "status", "issuetype", "parent"],
  });
  return (data.issues ?? []).map((i: any) => ({
    key: i.key, summary: i.fields?.summary ?? "", status: i.fields?.status?.name ?? "",
    type: i.fields?.issuetype?.name ?? "", parent: i.fields?.parent?.key ?? null,
    url: `${client.config.siteUrl}/browse/${i.key}`,
  }));
}

export async function getIssue(client: ReadOnlyJiraClient, key: string) {
  const fields = "summary,description,status,issuetype,parent,labels,components,priority,reporter,assignee";
  const i = await client.get(`/rest/api/3/issue/${issueKey(key)}?fields=${fields}`);
  const f = i.fields ?? {};
  return {
    key: i.key, summary: f.summary ?? "", description: plainText(f.description).slice(0, 6000),
    status: f.status?.name ?? "", type: f.issuetype?.name ?? "", parent: f.parent?.key ?? null,
    labels: f.labels ?? [], components: (f.components ?? []).map((c: any) => c.name),
    priority: f.priority?.name ?? null, reporter: f.reporter?.displayName ?? null, assignee: f.assignee?.displayName ?? null,
    url: `${client.config.siteUrl}/browse/${i.key}`,
  };
}

/** Name â†’ Jira account. Only active human accounts; email addresses are never returned. */
export async function findPeople(client: ReadOnlyJiraClient, query: string): Promise<JiraPerson[]> {
  const q = query.trim().slice(0, 80);
  if (!q) return [];
  const users = await client.get<any[]>(`/rest/api/3/user/search?${new URLSearchParams({ query: q, maxResults: "10" })}`);
  return users.filter(u => u.active !== false && (u.accountType ?? "atlassian") === "atlassian")
    .map(u => ({ accountId: String(u.accountId), displayName: String(u.displayName ?? "Unknown") }));
}
