import { buildCreateLink } from "../../shared/special-group/create-link.js";
import type { ProjectOptions, TicketDraft } from "../../shared/special-group/types.js";
import { applyDraftUpdate, parseDraftUpdate } from "./draft-resolver.js";
import { findPeople, getIssue, getProjectOptions, listProjects, screenFieldIds, searchIssues } from "./jira-lookups.js";
import type { ReadOnlyJiraClient } from "./read-only-client.js";

// The tools the assistant may call. Five read Jira; one edits the local draft.
// None of them can write to Jira: the person creates the ticket through the link.

const str = (description: string) => ({ type: "STRING", description });
const strList = (description: string) => ({ type: "ARRAY", items: { type: "STRING" }, description });
const projectKeyParam = str("Project key, for example DESK.");

export const SPECIAL_GROUP_TOOLS = [
  { name: "list_projects", description: "List Jira projects visible to this connection.",
    parameters: { type: "OBJECT", properties: { query: str("Optional name or key filter.") } } },
  { name: "get_project_options", description: "Read a project's valid work types, priorities, components, unreleased versions, and open epics. Call before choosing these values.",
    parameters: { type: "OBJECT", properties: { projectKey: projectKeyParam }, required: ["projectKey"] } },
  { name: "search_issues", description: "Find existing work items, for example to spot duplicates or a related epic.",
    parameters: { type: "OBJECT", properties: { projectKey: projectKeyParam, text: str("Words to search for."), type: str("Work type name."), openOnly: { type: "BOOLEAN" } }, required: ["projectKey"] } },
  { name: "get_issue", description: "Read one work item's details.",
    parameters: { type: "OBJECT", properties: { key: str("Work item key, for example DESK-12.") }, required: ["key"] } },
  { name: "find_people", description: "Find Jira users by name to use as reporter or assignee.",
    parameters: { type: "OBJECT", properties: { query: str("Name to search for.") }, required: ["query"] } },
  { name: "update_ticket_draft", description: "Change the ticket draft shown to the person. Send only the fields to change, using names (work type, priority, component, version, person) or keys (project, parent). The server checks each value against Jira and reports any it couldn't match.",
    parameters: { type: "OBJECT", properties: {
      projectKey: projectKeyParam, issueType: str("Work type name, for example Bug or Story."),
      summary: str("One-line title, at most 255 characters."), description: str("Full description in plain text."),
      parentKey: str("Epic or parent key, for example DESK-12."), priority: str("Priority name."),
      reporter: str("Person's name."), assignee: str("Person's name."),
      labels: strList("Labels; replaces the existing list."), components: strList("Component names; replaces the list."),
      fixVersions: strList("Version names; replaces the list."),
      clear: strList("Field names to empty: issueType, summary, description, parent, priority, reporter, assignee, labels, components, fixVersions."),
    } } },
];

export type ToolboxState = { draft: TicketDraft; draftChanged: boolean; options: ProjectOptions | null };

export function createToolbox(client: ReadOnlyJiraClient, initialDraft: TicketDraft) {
  const state: ToolboxState = { draft: initialDraft, draftChanged: false, options: null };
  const arg = (args: Record<string, unknown>, name: string) => typeof args[name] === "string" ? args[name] as string : "";

  async function execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "list_projects": return { projects: await listProjects(client, arg(args, "query")) };
      case "get_project_options": return getProjectOptions(client, arg(args, "projectKey"));
      case "search_issues": return { issues: await searchIssues(client, {
        projectKey: arg(args, "projectKey"), text: arg(args, "text"), type: arg(args, "type"), openOnly: args.openOnly === true }) };
      case "get_issue": return getIssue(client, arg(args, "key"));
      case "find_people": return { people: await findPeople(client, arg(args, "query")) };
      case "update_ticket_draft": {
        const result = await applyDraftUpdate(client, state.draft, parseDraftUpdate(args));
        state.draft = result.draft;
        state.options = result.options;
        state.draftChanged = true;
        const link = buildCreateLink(client.config.siteUrl, result.draft, result.options?.parentParam ?? null, await screenFieldIds(client, result.draft));
        // The URL itself stays out of the model's hands; the page shows it as a button.
        return { draft: result.draft, notes: result.notes, linkReady: link.url !== null, missing: link.missing, warnings: link.warnings };
      }
      default: throw new Error(`Unknown tool ${name}.`);
    }
  }
  return { declarations: SPECIAL_GROUP_TOOLS, execute, state };
}
