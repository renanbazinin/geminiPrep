// Types shared by the Special Group server and browser code.
// The app never writes to Jira: it reads metadata and builds a prefilled "create issue" link
// that a person opens, reviews, and submits in Jira themselves.

export type Named = { id: string; name: string };
export type JiraPerson = { accountId: string; displayName: string };

/** The ticket being prepared. IDs are what Jira needs; names are for people. */
export type TicketDraft = {
  project?: { id: string; key: string; name: string };
  issueType?: Named;
  summary?: string;
  description?: string;
  /** Epic or other parent work item, by key (for example DESK-12). */
  parent?: { key: string; summary?: string };
  priority?: Named;
  reporter?: JiraPerson;
  assignee?: JiraPerson;
  labels?: string[];
  components?: Named[];
  fixVersions?: Named[];
};

export type DraftField = keyof TicketDraft;

/** How a project expects its parent/epic to be prefilled in the create screen. */
export type ParentParam = { name: string; mode: "parent" | "epic-link" } | null;

/** Everything the draft card and the model need to choose valid values for one project. */
export type ProjectOptions = {
  project: { id: string; key: string; name: string; style: string };
  issueTypes: Array<Named & { subtask: boolean }>;
  priorities: Named[];
  components: Named[];
  versions: Named[];
  epics: Array<{ key: string; summary: string; status: string }>;
  parentParam: ParentParam;
};

export type ProjectSummary = { id: string; key: string; name: string };

export type CreateLink = {
  /** null until the project and work type are known. */
  url: string | null;
  missing: string[];
  warnings: string[];
};

export type SpecialGroupConnection = {
  configured: boolean;
  siteUrl: string;
  defaultProjectKey: string | null;
  readOnly: true;
};

/** One read-only lookup the assistant made while answering. Shown in the activity panel. */
export type LookupRecord = { tool: string; args: Record<string, unknown>; ok: boolean; result: unknown };

export type SpecialGroupChatResult = {
  text: string;
  /** Present when the assistant changed the draft during this turn. */
  draft?: TicketDraft;
  link?: CreateLink;
  lookups: LookupRecord[];
};

export type SpecialGroupMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  link?: CreateLink;
  lookups?: LookupRecord[];
  error?: boolean;
};

export type SpecialGroupSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: SpecialGroupMessage[];
  draft: TicketDraft;
};
