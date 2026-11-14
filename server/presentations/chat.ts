// The presentation tools in the chat: plan a deck, change the plan, create it, change it.
// slotdeck supplies the four tools and does the work; this file runs the chat model's tool
// loop on Generate Content and streams what happens to the browser.
import type { Response } from "express";
import {
  TOOL_NAMES,
  presentationTools,
  storeKeys,
  type GenerateProgress,
  type PresentationTools,
  type ToolResult,
} from "slotdeck";
import type { ChatPresentationCard, ChatStreamEvent, ChatStreamRequest } from "../../shared/contracts.js";
import { PRESENTATION_NOTE_PREFIX } from "../../shared/chat-tools.js";
import { createUpstreamRequest, describeUpstreamRequest, parseSseJson, upstreamErrorMessage } from "../chat/upstream.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import { resolvePresentationSettings } from "./config.js";
import { presentationModels } from "./models.js";
import { deckFieldValues, displayName, type StoredTemplate, type TemplateLibrary } from "./templates.js";

type Part = Record<string, unknown>;
type FunctionCall = { name: string; args: Record<string, unknown>; id?: string };
type GenerateContentBody = {
  contents: Array<{ role: string; parts: unknown[] }>;
  systemInstruction?: { role?: string; parts?: Array<{ text?: string }> };
  tools?: unknown[];
  toolConfig?: unknown;
  [key: string]: unknown;
};

/** What the chat model is told about the tools, after the user's own system instruction. */
export function presentationSystemPrompt(template: { name: string; layouts: string[]; photos: boolean }): string {
  return [
    "You make PowerPoint presentations for the user with the presentation tools.",
    `- A new presentation starts with ${TOOL_NAMES.plan}. Put every fact, figure and name the user gave, also from attached files, into "topic": the planner sees nothing else of this conversation.`,
    `- When the user wants a certain kind of slides ("no tables", "only cards"), pass that on in their words in "topic" or "instructions". For a presentation of text only, set "text_only" to true: "image_density": "none" only leaves out photos, and cards, tables and charts stay possible.`,
    `- After planning or changing a plan, the app shows the user the slides as a card. Do not list the slides again: say in a sentence or two what the plan covers, and ask whether to create it or change it.`,
    `- Call ${TOOL_NAMES.create} only after the user approved the plan, unless they asked you to create it without a review.`,
    `- Changes to a plan go to ${TOOL_NAMES.editPlan}; changes to a created presentation go to ${TOOL_NAMES.edit}. Pass the user's request on in their words.`,
    `- Plans and presentations from earlier turns appear in this conversation as notes that start with "${PRESENTATION_NOTE_PREFIX}". Take ids from there. Never write such a note yourself.`,
    "- When a presentation is created or changed, the app shows a card with the download button next to your answer. Say in a sentence or two what was made and mention any warnings. Never write a link or a file path, and do not say where on the screen the button is.",
    "- When a tool returns an error, tell the user what went wrong in plain words.",
    "- Answer in the user's language.",
    `The template is "${template.name}". Its layouts: ${template.layouts.join(", ")}.${template.photos ? "" : " Photos are turned off, so decks have no photos."}`,
  ].join("\n");
}

function progressText(event: GenerateProgress): string {
  if (event.stage === "outline") return "Choosing a layout for each slide…";
  if (event.stage === "write") return `Writing ${event.slides} ${event.slides === 1 ? "slide" : "slides"}…`;
  if (event.stage === "repair") return `Fitting the text to the template (round ${event.attempt})…`;
  if (event.stage === "images") return `Making pictures: ${event.done} of ${event.total}…`;
  return "Building the PowerPoint file…";
}

const CALL_LABELS: Record<string, string> = {
  [TOOL_NAMES.plan]: "Planning the presentation",
  [TOOL_NAMES.editPlan]: "Changing the plan",
  [TOOL_NAMES.create]: "Creating the presentation",
  [TOOL_NAMES.edit]: "Changing the presentation",
};

function megabytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function deckFileUrl(templateId: string, deckId: string): string {
  return `/api/presentations/files/${templateId}/${deckId}.pptx`;
}

/** The card the browser keeps for a tool result, or nothing for a result that made nothing. */
export function presentationCard(tool: string, result: ToolResult, template: StoredTemplate): ChatPresentationCard | undefined {
  const output = result.output;
  const base = { templateId: template.id, templateName: displayName(template) };
  const summary = typeof output.summary === "string" && output.summary.trim() ? { summary: output.summary.trim() } : {};
  if (result.plan && typeof output.plan_id === "string") {
    const slides = result.plan.slides.map((slide, index) => ({ number: index + 1, layout: slide.pattern, purpose: slide.purpose }));
    return {
      kind: "plan",
      id: output.plan_id,
      ...base,
      title: result.plan.title,
      ...(typeof output.language === "string" ? { language: output.language } : {}),
      slides,
      ...summary,
      context: JSON.stringify({
        tool,
        plan_id: output.plan_id,
        template: template.id,
        title: result.plan.title,
        slides,
        ...summary,
        ...(typeof output.previous_plan_id === "string" ? { replaces_plan_id: output.previous_plan_id } : {}),
        status: "planned, not created yet",
      }),
    };
  }
  if (result.deck && result.pptx && typeof output.presentation_id === "string") {
    const slides = result.deck.slides.map((slide, index) => {
      const title = slide.slots.title;
      return { number: index + 1, layout: slide.pattern, ...(typeof title === "string" && title ? { title } : {}) };
    });
    const warnings = Array.isArray(output.warnings) ? output.warnings.filter((warning): warning is string => typeof warning === "string") : [];
    return {
      kind: "deck",
      id: output.presentation_id,
      ...base,
      title: result.deck.title?.trim() || "Presentation",
      slides,
      file: deckFileUrl(template.id, output.presentation_id),
      bytes: result.pptx.byteLength,
      ...(warnings.length ? { warnings } : {}),
      ...summary,
      context: JSON.stringify({
        tool,
        presentation_id: output.presentation_id,
        template: template.id,
        title: result.deck.title,
        slides,
        ...summary,
        ...(typeof output.plan_id === "string" ? { from_plan_id: output.plan_id } : {}),
        ...(typeof output.previous_presentation_id === "string" ? { replaces_presentation_id: output.previous_presentation_id } : {}),
        status: "created; the user has the file",
      }),
    };
  }
  return undefined;
}

function stepText(tool: string, result: ToolResult, card: ChatPresentationCard | undefined): string {
  const label = CALL_LABELS[tool] ?? tool;
  if (typeof result.output.error === "string") return `${label} — failed: ${result.output.error}`;
  if (card?.kind === "plan") return `${label} — ${card.slides.length} slides: ${card.title}`;
  if (card?.kind === "deck") return `${label} — ${card.slides.length} slides, ${megabytes(card.bytes)}${card.warnings?.length ? `, ${card.warnings.length} warning${card.warnings.length === 1 ? "" : "s"}` : ""}`;
  return label;
}

/**
 * A chat turn with the presentation tools. Runs on Generate Content whichever chat API is
 * selected, because the tool loop needs function calling with the whole conversation.
 *
 * `resumed` is set when the chat model handed the turn over (Tools on Auto): the stream is
 * already open, so the events carry on from where the first model stopped.
 */
export async function proxyPresentationChat(options: {
  request: ChatStreamRequest;
  project: string | null;
  response: Response;
  library: TemplateLibrary;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  resumed?: { startedMs: number; chunkCount: number; textCharacters: number; firstTokenMs?: number };
}): Promise<void> {
  const { project, response, library, signal, resumed, fetchImpl = fetch } = options;
  const settings = resolvePresentationSettings();
  const startedMs = resumed?.startedMs ?? Date.now();
  const send = (event: ChatStreamEvent) => {
    if (!signal?.aborted && !response.writableEnded) response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
  const fail = (status: number, message: string) => {
    if (resumed) {
      send({ event: "error", data: { message, status, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs } });
      response.end();
    } else {
      response.status(status).json({ error: message });
    }
  };

  const chosen = await library.resolve(options.request.presentationTemplate);
  if (!chosen) {
    fail(409, "There is no presentation template with layouts yet. Make one in Template Studio.");
    return;
  }
  let models: ReturnType<typeof presentationModels>;
  try {
    models = presentationModels({ provider: options.request.provider, model: options.request.model, project, fetchImpl, settings });
  } catch (error) {
    fail(400, error instanceof Error ? error.message : String(error));
    return;
  }

  // Tool calling runs on Generate Content, whichever chat API is selected.
  const { interactions: _i, interactionProject: _p, previousInteractionId: _id, cachedContent: _c, ...rest } = options.request;
  const request: ChatStreamRequest = { ...rest, tool: "presentation" };
  const vertexToken = request.provider === "vertex" ? await getVertexAccessToken() : undefined;
  const upstream = createUpstreamRequest({ request, project, vertexToken, geminiApiKey: process.env.GEMINI_API_KEY });
  const headers = upstream.init.headers as Record<string, string>;
  const body = JSON.parse(upstream.init.body as string) as GenerateContentBody;

  /** The tools of one template. A plan or deck is always worked on with the template it was made with. */
  const toolsets = new Map<string, { template: StoredTemplate; tools: PresentationTools }>();
  const toolsFor = async (template: StoredTemplate) => {
    let entry = toolsets.get(template.id);
    if (!entry) {
      const icons = await library.icons(template);
      entry = {
        template,
        tools: presentationTools({
          template: template.template,
          llm: models.llm,
          ...(models.images ? { images: models.images } : {}),
          ...(icons.length ? { icons } : {}),
          store: library.store(template.id),
          // Optional parts of a layout may be left out, and their shapes go with them.
          layout: "adaptive",
          fields: deckFieldValues(template),
          onProgress: (event) => send({ event: "activity", data: { text: progressText(event) } }),
        }),
      };
      toolsets.set(template.id, entry);
    }
    return entry;
  };
  /** The template a call's plan or deck belongs to: the chosen one, unless the id is kept with another. */
  const templateOf = async (args: Record<string, unknown>): Promise<StoredTemplate> => {
    const key = typeof args.plan_id === "string" ? storeKeys.plan(args.plan_id.trim())
      : typeof args.presentation_id === "string" ? storeKeys.deck(args.presentation_id.trim())
        : undefined;
    if (!key || !/^(plan|deck)\/[A-Za-z0-9_]+\.json$/.test(key)) return chosen;
    if (await library.store(chosen.id).get(key)) return chosen;
    for (const other of await library.list()) {
      if (other.id !== chosen.id && await library.store(other.id).get(key)) return other;
    }
    return chosen;
  };

  const main = await toolsFor(chosen);
  const guidance = presentationSystemPrompt({
    name: displayName(chosen),
    layouts: chosen.template.manifest.patterns.map((pattern) => pattern.id),
    photos: Boolean(models.images),
  });
  body.systemInstruction = { role: "system", parts: [{ text: [body.systemInstruction?.parts?.[0]?.text, guidance].filter(Boolean).join("\n\n") }] };
  body.tools = [{ functionDeclarations: main.tools.definitions }];
  body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };

  if (!resumed) {
    response.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    response.flushHeaders();
    send({ event: "meta", data: {
      api: "generateContent",
      provider: request.provider,
      model: request.model,
      ...(request.region ? { region: request.region } : {}),
      startedAt: new Date(startedMs).toISOString(),
      providerRequest: describeUpstreamRequest({ url: upstream.url, init: { ...upstream.init, body: JSON.stringify(body) } }),
    } });
  }

  let textCharacters = resumed?.textCharacters ?? 0;
  let chunkCount = resumed?.chunkCount ?? 0;
  let firstTokenMs = resumed?.firstTokenMs;
  let finishReason: string | undefined;
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const cards: ChatPresentationCard[] = [];
  const reportError = (message: string, status?: number) => send({ event: "error", data: {
    message,
    ...(status === undefined ? {} : { status }),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
  } });

  /** Streams one model turn to the browser. Returns null after reporting an error. */
  const streamTurn = async (): Promise<{ parts: Part[]; calls: FunctionCall[] } | null> => {
    const result = await fetchImpl(upstream.url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!result.ok) {
      const value: unknown = await result.json().catch(() => null);
      reportError(upstreamErrorMessage(value, result.status), result.status);
      return null;
    }
    if (!result.body) throw new Error("The model provider returned an empty stream.");
    const parts: Part[] = [];
    const calls: FunctionCall[] = [];
    let separated = textCharacters === 0;
    try {
      for await (const chunk of parseSseJson(result.body)) {
        chunkCount++;
        if (chunk.error?.message) throw new Error(chunk.error.message);
        const candidate = chunk.candidates?.[0];
        for (const part of (candidate?.content?.parts ?? []) as Part[]) {
          // Keep every part as received: Gemini 3 requires its thought signatures back.
          parts.push(part);
          if (typeof part.text === "string" && part.text && part.thought !== true) {
            if (!separated) {
              send({ event: "delta", data: { text: "\n\n" } });
              separated = true;
            }
            firstTokenMs ??= Date.now() - startedMs;
            textCharacters += part.text.length;
            send({ event: "delta", data: { text: part.text } });
          }
          const call = part.functionCall as { name?: unknown; args?: unknown; id?: unknown } | undefined;
          if (call && typeof call.name === "string") {
            const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {};
            calls.push({ name: call.name, args, ...(typeof call.id === "string" ? { id: call.id } : {}) });
          }
        }
        finishReason = candidate?.finishReason ?? finishReason;
        responseId = chunk.responseId ?? responseId;
        usage = chunk.usageMetadata ?? usage;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      reportError(error instanceof Error ? error.message : String(error), result.status);
      return null;
    }
    return { parts, calls };
  };

  for (let turn = 1; ; turn++) {
    // The last turn has no tools declared, so it can only be the answer.
    const last = turn >= settings.maxToolTurns;
    if (last) {
      delete body.tools;
      delete body.toolConfig;
    }
    const result = await streamTurn();
    if (!result) {
      response.end();
      return;
    }
    if (result.calls.length === 0 || last) break;
    body.contents.push({ role: "model", parts: result.parts });
    const responses: unknown[] = [];
    for (const call of result.calls) {
      send({ event: "activity", data: { text: `${CALL_LABELS[call.name] ?? call.name}…` } });
      const { template, tools } = await toolsFor(await templateOf(call.args));
      // Expected failures (an unknown id, a limit) come back as { error } for the model to explain.
      const outcome = await tools.call(call.name, call.args, signal ? { signal } : undefined);
      const card = presentationCard(call.name, outcome, template);
      if (card) {
        cards.push(card);
        send({ event: "presentation", data: card });
      }
      send({ event: "step", data: { text: stepText(call.name, outcome, card) } });
      responses.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: outcome.output } });
    }
    body.contents.push({ role: "user", parts: responses });
  }

  if (textCharacters === 0) {
    const made = cards.at(-1);
    send({ event: "delta", data: { text: made?.kind === "plan"
      ? "The plan is ready. Tell me to create it, or what to change."
      : made?.kind === "deck"
        ? "The presentation is ready."
        : `The model finished without an answer${finishReason ? ` (${finishReason})` : ""}. Try asking again.` } });
  }
  send({ event: "done", data: {
    ...(finishReason ? { finishReason } : {}),
    ...(responseId ? { responseId } : {}),
    ...(usage ? { usage } : {}),
    providerStatus: 200,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    ...(firstTokenMs === undefined ? {} : { timeToFirstTokenMs: firstTokenMs }),
    chunkCount,
    textCharacters,
  } });
  response.end();
}
