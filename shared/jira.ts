export const JIRA_TEAM = [
  { name: "Renan", role: "Software · backend", label: "demo-owner-renan" },
  { name: "Dana", role: "Project manager", label: "demo-owner-dana" },
  { name: "Bobo", role: "Software · frontend", label: "demo-owner-bobo" },
  { name: "Koko", role: "QA", label: "demo-owner-koko" },
] as const;

export type JiraIssue = {
  key: string; summary: string; description: string; status: string;
  type: string; owner: string | null; assignee: string | null;
  labels: string[]; url: string; updated: string;
};
export type JiraAction = { tool: string; ok: boolean; result: unknown };
export type JiraChatResult = { text: string; actions: JiraAction[] };
export type JiraConnection = {
  configured: boolean; siteUrl: string; projectKey: string;
  ownershipMode: "simulated-labels";
};
