import { normalizeLabel } from "../../shared/special-group/create-link.js";
import { DRAFT_LIMITS } from "../../shared/special-group/draft.js";
import type { DraftField, Named, ProjectOptions, TicketDraft } from "../../shared/special-group/types.js";
import { findPeople, getIssue, getProjectOptions, issueKey, projectKey } from "./jira-lookups.js";
import type { ReadOnlyJiraClient } from "./read-only-client.js";

// Turns the assistant's human-friendly draft update ("type Bug, epic DESK-12, reporter Dana")
// into exact Jira IDs, checked against live metadata. Anything that can't be matched
// exactly is left unchanged and explained in `notes`, so the assistant can ask the person.

export type DraftUpdate = {
  projectKey?: string; issueType?: string; summary?: string; description?: string; parentKey?: string;
  priority?: string; reporter?: string; assignee?: string;
  labels?: string[]; components?: string[]; fixVersions?: string[];
  clear?: string[];
};

const CLEARABLE: DraftField[] = ["issueType", "summary", "description", "parent", "priority", "reporter", "assignee", "labels", "components", "fixVersions"];
/** Fields whose IDs belong to one project and must be re-chosen when the project changes. */
const PROJECT_SCOPED: DraftField[] = ["issueType", "parent", "components", "fixVersions"];

const str = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
const list = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map(v => v.trim()) : undefined;
const sameName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

export function parseDraftUpdate(args: Record<string, unknown>): DraftUpdate {
  return {
    projectKey: str(args.projectKey), issueType: str(args.issueType), summary: str(args.summary),
    description: str(args.description), parentKey: str(args.parentKey), priority: str(args.priority),
    reporter: str(args.reporter), assignee: str(args.assignee), labels: list(args.labels),
    components: list(args.components), fixVersions: list(args.fixVersions), clear: list(args.clear),
  };
}

function pick(options: Named[], name: string, field: string, notes: string[]): Named | undefined {
  const match = options.find(option => sameName(option.name, name));
  if (!match) notes.push(`${field} "${name}" doesn't exist here. Options: ${options.map(o => o.name).join(", ") || "none"}.`);
  return match;
}

function pickMany(options: Named[], names: string[], field: string, notes: string[]): Named[] {
  return names.map(name => pick(options, name, field, notes)).filter((item): item is Named => Boolean(item));
}

async function pickPerson(client: ReadOnlyJiraClient, query: string, role: string, notes: string[]) {
  const people = await findPeople(client, query);
  const exact = people.filter(p => sameName(p.displayName, query));
  const chosen = exact.length === 1 ? exact[0] : people.length === 1 ? people[0] : undefined;
  if (!chosen) {
    notes.push(people.length ? `Several people match ${role} "${query}": ${people.map(p => p.displayName).join(", ")}. Ask which one.`
      : `No Jira user matches ${role} "${query}".`);
  }
  return chosen;
}

export async function applyDraftUpdate(client: ReadOnlyJiraClient, current: TicketDraft, update: DraftUpdate) {
  const draft: TicketDraft = { ...current };
  const notes: string[] = [];
  for (const field of update.clear ?? []) {
    if (CLEARABLE.includes(field as DraftField)) delete draft[field as DraftField];
  }

  if (update.projectKey && projectKey(update.projectKey) !== draft.project?.key) {
    const options = await getProjectOptions(client, update.projectKey);
    if (draft.project) {
      for (const field of PROJECT_SCOPED) delete draft[field];
      notes.push("Project changed, so work type, parent, components, and versions were reset.");
    }
    draft.project = { id: options.project.id, key: options.project.key, name: options.project.name };
  }
  const needsProject = update.issueType || update.parentKey || update.priority || update.components || update.fixVersions;
  if (needsProject && !draft.project) notes.push("Choose a project first; work type, parent, priority, components, and versions depend on it.");
  const options: ProjectOptions | null = draft.project ? await getProjectOptions(client, draft.project.key) : null;

  if (options && update.issueType) {
    const type = pick(options.issueTypes.filter(t => !t.subtask), update.issueType, "Work type", notes);
    if (type) draft.issueType = { id: type.id, name: type.name };
  }
  if (update.summary) draft.summary = update.summary.replace(/\s+/g, " ").slice(0, DRAFT_LIMITS.summary);
  if (update.description) draft.description = update.description.slice(0, DRAFT_LIMITS.description);
  if (options && update.parentKey) {
    const key = issueKey(update.parentKey);
    const epic = options.epics.find(e => e.key === key);
    if (epic) draft.parent = { key, summary: epic.summary };
    else if (!key.startsWith(`${options.project.key}-`)) notes.push(`Parent ${key} is in another project. Use a ${options.project.key} epic.`);
    else {
      try { const issue = await getIssue(client, key); draft.parent = { key, summary: issue.summary }; }
      catch { notes.push(`Parent ${key} wasn't found or isn't visible.`); }
    }
  }
  if (options && update.priority) {
    const priority = pick(options.priorities, update.priority, "Priority", notes);
    if (priority) draft.priority = priority;
  }
  if (update.reporter) { const p = await pickPerson(client, update.reporter, "reporter", notes); if (p) draft.reporter = p; }
  if (update.assignee) { const p = await pickPerson(client, update.assignee, "assignee", notes); if (p) draft.assignee = p; }
  if (update.labels) draft.labels = [...new Set(update.labels.map(normalizeLabel).filter(Boolean))].slice(0, DRAFT_LIMITS.labels);
  if (options && update.components) draft.components = pickMany(options.components, update.components, "Component", notes);
  if (options && update.fixVersions) draft.fixVersions = pickMany(options.versions, update.fixVersions, "Fix version", notes);
  if (draft.labels?.length === 0) delete draft.labels;
  if (draft.components?.length === 0) delete draft.components;
  if (draft.fixVersions?.length === 0) delete draft.fixVersions;
  return { draft, notes, options };
}
