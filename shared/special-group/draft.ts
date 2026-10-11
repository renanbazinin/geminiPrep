import { normalizeLabel } from "./create-link.js";
import type { JiraPerson, Named, TicketDraft } from "./types.js";

// Shape checks for a ticket draft that arrives from an untrusted place
// (a browser request, localStorage). Unknown or malformed fields are dropped, never guessed.

export const DRAFT_LIMITS = { summary: 255, description: 20000, labels: 10, multi: 20 } as const;
const ID = /^[0-9]{1,18}$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const ACCOUNT_ID = /^[A-Za-z0-9:_-]{1,128}$/;

const isObject = (value: unknown): value is Record<string, any> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : undefined;

function named(value: unknown): Named | undefined {
  return isObject(value) && typeof value.id === "string" && ID.test(value.id) && typeof value.name === "string"
    ? { id: value.id, name: value.name.slice(0, 200) } : undefined;
}
function person(value: unknown): JiraPerson | undefined {
  return isObject(value) && typeof value.accountId === "string" && ACCOUNT_ID.test(value.accountId)
    ? { accountId: value.accountId, displayName: String(value.displayName ?? "").slice(0, 200) } : undefined;
}
function namedList(value: unknown): Named[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value.map(named).filter((item): item is Named => Boolean(item)).slice(0, DRAFT_LIMITS.multi);
  return list.length ? list : undefined;
}

export function sanitizeDraft(value: unknown): TicketDraft {
  if (!isObject(value)) return {};
  const draft: TicketDraft = {};
  const p = value.project;
  if (isObject(p) && typeof p.id === "string" && ID.test(p.id) && typeof p.key === "string" && PROJECT_KEY.test(p.key)) {
    draft.project = { id: p.id, key: p.key, name: String(p.name ?? p.key).slice(0, 200) };
  }
  draft.issueType = named(value.issueType);
  draft.summary = text(value.summary, DRAFT_LIMITS.summary);
  draft.description = text(value.description, DRAFT_LIMITS.description);
  if (isObject(value.parent) && typeof value.parent.key === "string" && ISSUE_KEY.test(value.parent.key)) {
    draft.parent = { key: value.parent.key, ...(typeof value.parent.summary === "string" ? { summary: value.parent.summary.slice(0, 255) } : {}) };
  }
  draft.priority = named(value.priority);
  draft.reporter = person(value.reporter);
  draft.assignee = person(value.assignee);
  if (Array.isArray(value.labels)) {
    const labels = [...new Set(value.labels.filter((l: unknown): l is string => typeof l === "string").map(normalizeLabel).filter(Boolean))];
    if (labels.length) draft.labels = labels.slice(0, DRAFT_LIMITS.labels);
  }
  draft.components = namedList(value.components);
  draft.fixVersions = namedList(value.fixVersions);
  // Drop undefined keys so drafts compare and serialize cleanly.
  return Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) as TicketDraft;
}

export function isDraftEmpty(draft: TicketDraft): boolean {
  return Object.keys(draft).length === 0;
}
