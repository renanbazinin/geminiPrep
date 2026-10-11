import type { CreateLink, ParentParam, TicketDraft } from "./types.js";

// Builds the Jira Cloud "create issue" link with fields already filled in.
// Opening it shows Jira's own create screen; nothing is created until the person presses Create.
// This module is pure (no network) so the browser can rebuild the link on every keystroke.

export const CREATE_ISSUE_PATH = "/secure/CreateIssueDetails!init.jspa";
/** Long query strings can be cut off by proxies and browsers; warn well before that point. */
export const MAX_SAFE_LINK_LENGTH = 6000;

/** Jira labels cannot contain spaces. */
export function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, "-").slice(0, 255);
}

/**
 * @param screenFields Field IDs on this work type's create screen, when known. Jira silently ignores
 *   parameters for fields that aren't on the screen, so those are left out and reported instead.
 */
export function buildCreateLink(siteUrl: string, draft: TicketDraft, parentParam: ParentParam = null, screenFields: string[] | null = null): CreateLink {
  const missing: string[] = [];
  const warnings: string[] = [];
  if (!draft.project) missing.push("project");
  if (!draft.issueType) missing.push("work type");
  if (!draft.summary?.trim()) missing.push("summary");
  if (!draft.project || !draft.issueType) return { url: null, missing, warnings };
  const typeName = draft.issueType.name;
  const onScreen = (fieldId: string, label: string) => {
    if (!screenFields || screenFields.includes(fieldId)) return true;
    warnings.push(`${label} isn't on the ${typeName} create screen, so Jira would ignore it. Set it after creating, or ask a Jira admin to add the field.`);
    return false;
  };

  // Each entry maps one draft field to the query parameter Jira's create screen reads.
  const params = new URLSearchParams();
  params.set("pid", draft.project.id);
  params.set("issuetype", draft.issueType.id);
  if (draft.summary?.trim()) params.set("summary", draft.summary.trim());
  if (draft.description?.trim() && onScreen("description", "Description")) params.set("description", draft.description.trim());
  if (draft.priority && onScreen("priority", "Priority")) params.set("priority", draft.priority.id);
  if (draft.reporter && onScreen("reporter", "Reporter")) params.set("reporter", draft.reporter.accountId);
  if (draft.assignee && onScreen("assignee", "Assignee")) params.set("assignee", draft.assignee.accountId);
  if (draft.labels?.length && onScreen("labels", "Labels")) {
    for (const label of draft.labels) if (normalizeLabel(label)) params.append("labels", normalizeLabel(label));
  }
  if (draft.components?.length && onScreen("components", "Components")) {
    for (const component of draft.components) params.append("components", component.id);
  }
  if (draft.fixVersions?.length && onScreen("fixVersions", "Fix versions")) {
    for (const version of draft.fixVersions) params.append("fixVersions", version.id);
  }
  if (draft.parent) {
    if (!parentParam) warnings.push(`Jira can't prefill the parent here. Set it to ${draft.parent.key} on the create screen.`);
    else if (onScreen(parentParam.name, "Epic / parent")) params.set(parentParam.name, draft.parent.key);
  }

  // URLSearchParams writes spaces as "+"; a literal "+" is already "%2B", so this is lossless.
  const url = `${siteUrl.replace(/\/$/, "")}${CREATE_ISSUE_PATH}?${params.toString().replace(/\+/g, "%20")}`;
  if (url.length > MAX_SAFE_LINK_LENGTH) {
    warnings.push(`The link is ${url.length} characters and may be cut off. Shorten the description or paste it in Jira.`);
  }
  return { url, missing, warnings };
}
