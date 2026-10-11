import type { ChatStreamRequest } from "../../shared/contracts.js";
import { buildCreateLink } from "../../shared/special-group/create-link.js";
import type { SpecialGroupChatResult, TicketDraft } from "../../shared/special-group/types.js";
import { createUpstreamRequest } from "../chat/upstream.js";
import { getProjectOptions, screenFieldIds } from "./jira-lookups.js";
import { runToolLoop, toGenerateContentUrl } from "./model-loop.js";
import type { ReadOnlyJiraClient } from "./read-only-client.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { createToolbox } from "./tools.js";

// One chat turn: prompt + tools + model loop → answer text, and the updated draft and link if it changed.

export async function runSpecialGroupChat(options: {
  request: ChatStreamRequest;
  draft: TicketDraft;
  client: ReadOnlyJiraClient;
  project: string | null;
  vertexToken?: string;
  fetchImpl?: typeof fetch;
  today?: string;
}): Promise<SpecialGroupChatResult> {
  const { request, draft, client, fetchImpl } = options;
  // Reuse the app's provider plumbing (Vertex or Gemini API), then replace prompt and tools with ours.
  const upstream = createUpstreamRequest({
    request: { ...request, tool: undefined, cachedContent: undefined, systemInstruction: undefined },
    project: options.project, vertexToken: options.vertexToken, geminiApiKey: process.env.GEMINI_API_KEY,
  });
  const body = JSON.parse(upstream.init.body as string);
  body.systemInstruction = { parts: [{ text: buildSystemPrompt({
    siteUrl: client.config.siteUrl, defaultProjectKey: client.config.defaultProjectKey, draft,
    today: options.today ?? new Date().toISOString().slice(0, 10),
  }) }] };
  const toolbox = createToolbox(client, draft);
  body.tools = [{ functionDeclarations: toolbox.declarations }];
  body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };

  let text: string;
  let lookups: SpecialGroupChatResult["lookups"] = [];
  try {
    ({ text, calls: lookups } = await runToolLoop({ url: toGenerateContentUrl(upstream.url), init: upstream.init, body, execute: toolbox.execute, fetchImpl }));
  } catch (error) {
    // Keep any draft progress made before the failure.
    if (!toolbox.state.draftChanged) throw error;
    text = `${error instanceof Error ? error.message : "The model stopped early."} The draft below has the changes made so far.`;
  }
  if (!toolbox.state.draftChanged) return { text, lookups };
  const next = toolbox.state.draft;
  const projectOptions = toolbox.state.options ?? (next.project ? await getProjectOptions(client, next.project.key).catch(() => null) : null);
  const screenFields = await screenFieldIds(client, next);
  return { text, lookups, draft: next, link: buildCreateLink(client.config.siteUrl, next, projectOptions?.parentParam ?? null, screenFields) };
}
