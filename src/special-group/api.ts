import type {
  JiraPerson, ProjectOptions, ProjectSummary, SpecialGroupChatResult, SpecialGroupConnection, TicketDraft,
} from "../../shared/special-group/types";

// Browser → /api/special-group. One function per endpoint so each call is easy to find and mock.

const BASE = "/api/special-group";

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data as T;
}

export type ChatSettings = {
  provider: "vertex" | "gemini"; model: string; region?: string;
  temperature: number; maxOutputTokens: number; thinkingLevel?: "low" | "high";
};

export const specialGroupApi = {
  config: () => request<SpecialGroupConnection>("/config"),
  prompt: () => request<{ prompt: string }>("/prompt"),
  connect: (input: { siteUrl: string; email: string; token: string; scoped: boolean }) =>
    request<{ connected: true; account: string | null; projects: number }>("/connect", input),
  projects: (query = "") => request<{ projects: ProjectSummary[] }>(`/projects?${new URLSearchParams({ query })}`),
  projectOptions: (key: string, fresh = false) => request<ProjectOptions>(`/projects/${encodeURIComponent(key)}/options${fresh ? "?fresh=1" : ""}`),
  people: (query: string) => request<{ people: JiraPerson[] }>(`/people?${new URLSearchParams({ query })}`),
  chat: (input: ChatSettings & { messages: Array<{ role: "user" | "assistant"; content: string }>; draft: TicketDraft }) =>
    request<SpecialGroupChatResult>("/chat", input),
};
