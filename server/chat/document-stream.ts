import type { Response } from "express";
import type { ChatStreamEvent, ChatStreamRequest } from "../../shared/contracts.js";
import { gemini4OutputTokens, isGemini4Model } from "../../shared/gemini-4.js";
import {
  createGeminiGenerateText,
  estimateTokens,
  geminiFunctionResponses,
  jsonBytes,
  type GeminiFunctionCall,
  type LargeFiles,
  type PreparedContext,
  type ToolResult,
} from "../../packages/large-files/src/index.js";
import { toGenerateContentUrl } from "../special-group/model-loop.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import { resolveLargeFilesSettings, type ServerLargeFiles } from "../documents/config.js";
import type { TemplateLibrary } from "../presentations/templates.js";
import { streamWithPackage } from "./document-stream-npm.js";
import { proxyChatStream } from "./stream.js";
import { createUpstreamRequest, describeUpstreamRequest, parseSseJson, upstreamErrorMessage } from "./upstream.js";

/** Sent, invisibly to the user, when the model must stop using tools and answer. */
const FINAL_ANSWER_REQUEST = "Stop using tools now. Answer my question using only what the tools returned above, with line citations. Say plainly what you could not find.";

type Part = Record<string, unknown>;
type GenerateContentBody = {
  contents: Array<{ role: string; parts: unknown[] }>;
  systemInstruction?: { role?: string; parts?: Array<{ text?: string }> };
  tools?: unknown[];
  toolConfig?: unknown;
  [key: string]: unknown;
};

export function hasDocumentParts(request: ChatStreamRequest): boolean {
  return request.messages.some((message) => message.files?.some((file) => file.kind === "document"));
}

function documentIds(request: ChatStreamRequest): string[] {
  return request.messages.flatMap((message) => (message.files ?? [])
    .flatMap((file) => (file.kind === "document" ? [file.documentId] : [])));
}

/** Size of everything in the request except the documents, for the planner. */
export function baseRequestSize(request: ChatStreamRequest): { tokens: number; bytes: number } {
  let tokens = estimateTokens(request.systemInstruction ?? "") + 2_000;
  let bytes = jsonBytes(request.systemInstruction ?? "") + 8_000;
  for (const message of request.messages) {
    tokens += estimateTokens(message.content);
    bytes += jsonBytes(message.content) + 100;
    for (const file of message.files ?? []) {
      if (file.kind === "text") {
        tokens += estimateTokens(file.text);
        bytes += jsonBytes(file.text);
      } else if (file.kind === "inlineData") {
        bytes += file.data.length + 200;
        // Gemini bills about 258 tokens per PDF page; ~4 tokens per KB is a cautious stand-in.
        tokens += Math.ceil((file.data.length * 0.75) / 256);
      }
    }
  }
  return { tokens, bytes };
}

/** Replaces document references with their planned text: the full file, or a summary card. */
export function materializeDocuments(request: ChatStreamRequest, blocks: Map<string, string>): ChatStreamRequest {
  const placed = new Set<string>();
  return {
    ...request,
    messages: request.messages.map((message) => {
      const documents = (message.files ?? []).filter((file) => file.kind === "document");
      if (documents.length === 0) return message;
      const rest = (message.files ?? []).filter((file) => file.kind !== "document");
      const texts = documents.map((file) => {
        if (file.kind !== "document") return "";
        if (placed.has(file.documentId)) return `(The file ${file.name} is attached earlier in this conversation.)`;
        placed.add(file.documentId);
        return blocks.get(file.documentId) ?? "";
      }).filter(Boolean);
      return {
        role: message.role,
        content: [message.content, ...texts].filter((text) => text.trim()).join("\n\n"),
        ...(rest.length ? { files: rest } : {}),
      };
    }),
  };
}

/** What a finished tool call found, appended to its description for the steps list. */
function stepSummary(label: string, result: ToolResult): string {
  if (typeof result.error === "string") return ` — failed: ${result.error}`;
  if (typeof result.total_matching_lines === "number") return ` — ${result.total_matching_lines.toLocaleString("en-US")} matching lines`;
  if (Array.isArray(result.passages)) return ` — ${result.passages.length} passages`;
  if (typeof result.parts_read === "number") return ` — ${result.parts_read} parts, ${String(result.parts_with_relevant_content ?? 0)} relevant`;
  // A read reports its range only when it was cut short of what was asked.
  if (typeof result.lines === "string" && typeof result.total_lines === "number") return label.endsWith(result.lines) ? "" : ` — got ${result.lines}`;
  return "";
}

/**
 * Chat with large server-side files. Files that fit go into the prompt and the normal chat path
 * runs (Generate Content or Interactions). Otherwise the model gets search/read tools and a
 * streaming Generate Content tool loop runs: askGemini from llm-large-files on the npm engine,
 * or this file's own loop on the original engine.
 *
 * A PDF whose file is kept (npm engine) also gets that loop when its text fits: its text does not
 * hold its pictures, and the loop gives the model view_pages to look at the pages themselves.
 * This happens only in a plain Generate Content chat: see `looks` below.
 */
export async function proxyDocumentChat(options: {
  request: ChatStreamRequest;
  project: string | null;
  response: Response;
  largeFiles: ServerLargeFiles;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  presentations?: TemplateLibrary;
}): Promise<void> {
  const { request, response, largeFiles } = options;
  const ids = documentIds(request);
  const base = baseRequestSize(request);
  const prepared = await largeFiles.files.prepare(ids, base);
  if (prepared.missing.length) {
    const names = request.messages.flatMap((message) => message.files ?? [])
      .filter((file) => file.kind === "document" && prepared.missing.includes(file.documentId))
      .map((file) => file.name);
    response.status(410).json({
      error: `${[...new Set(names)].join(", ")} ${names.length === 1 ? "is" : "are"} no longer on the server. Start a new chat and attach the file again.`,
    });
    return;
  }
  const materialized = materializeDocuments(request, prepared.blocks);
  const searches = prepared.plan.searchable.length > 0;
  // Everything fits. Does a PDF among the files have pages to look at? The loop runs on Generate
  // Content and declares only the document tools, so it is not used where the user chose
  // something it would drop: the image or graph tool, or the Interactions API with its options.
  // Those answer as before, from the text alone.
  const looks = !searches && largeFiles.engine === "npm" && !request.tool && !request.interactions
    && resolveLargeFilesSettings().keepPdfs
    && (await largeFiles.files.prepare(ids, base, { viewPages: true })).viewable.length > 0;
  // Nothing to search or to look at, or the image model is answering (it cannot call tools), or the
  // presentation tools are (they plan from the text or summary card of each file): use the normal path.
  if ((!searches && !looks) || request.tool === "image" || request.tool === "presentation") {
    await proxyChatStream({ ...options, request: materialized });
    return;
  }
  if (request.previousInteractionId) {
    response.status(409).json({ error: "Large files need the full conversation history. Reconnect from local history and send again." });
    return;
  }
  if (largeFiles.engine === "npm") {
    // askGemini plans and places the documents itself, so it gets the original references.
    await streamWithPackage({ ...options, files: largeFiles.files });
    return;
  }
  await runToolLoop({ ...options, request: materialized, prepared, largeFiles: largeFiles.files });
}

async function runToolLoop(options: {
  request: ChatStreamRequest;
  prepared: PreparedContext;
  project: string | null;
  response: Response;
  largeFiles: LargeFiles;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const { prepared, project, response, largeFiles, signal, fetchImpl = fetch } = options;
  const maxTurns = resolveLargeFilesSettings().maxToolTurns;
  // Tool calling runs on Generate Content, whichever chat API is selected.
  const { interactions: _i, interactionProject: _p, previousInteractionId: _id, cachedContent: _c, ...request } = options.request;
  const startedMs = Date.now();
  const vertexToken = request.provider === "vertex" ? await getVertexAccessToken() : undefined;
  const upstream = createUpstreamRequest({ request, project, vertexToken, geminiApiKey: process.env.GEMINI_API_KEY });
  const headers = upstream.init.headers as Record<string, string>;
  const body = JSON.parse(upstream.init.body as string) as GenerateContentBody;
  const system = [body.systemInstruction?.parts?.[0]?.text, prepared.instruction].filter(Boolean).join("\n\n");
  body.systemInstruction = { role: "system", parts: [{ text: system }] };

  const send = (event: ChatStreamEvent) => {
    if (!signal?.aborted && !response.writableEnded) response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
  const gemini4 = isGemini4Model(request.model);
  const tools = largeFiles.tools(prepared.plan.searchable, {
    generate: createGeminiGenerateText({
      url: toGenerateContentUrl(upstream.url),
      headers,
      fetchImpl,
      generationConfig: (maxOutputTokens) => ({
        ...(gemini4 ? {} : { temperature: 0.2 }),
        maxOutputTokens: gemini4 ? gemini4OutputTokens(maxOutputTokens) : maxOutputTokens,
        ...(request.thinkingLevel ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
      }),
    }),
    onProgress: (event) => send({ event: "activity", data: { text: `${event.message}…` } }),
    signal,
  });
  // Only the document tools: an image or diagram specialist could not see what the tools found.
  body.tools = [{ functionDeclarations: tools.declarations }];
  body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };

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
  const searchable = prepared.plan.searchable.map((meta) => meta.name).join(", ");
  send({ event: "activity", data: { text: `Too large to read at once: ${searchable}. Searching it instead…` } });

  let textCharacters = 0;
  let chunkCount = 0;
  let firstTokenMs: number | undefined;
  let finishReason: string | undefined;
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;

  /** Streams one model turn to the browser. Returns null after reporting an error. */
  const streamTurn = async (label: string): Promise<{ parts: Part[]; calls: GeminiFunctionCall[] } | null> => {
    const result = await fetchImpl(upstream.url, { method: "POST", headers, body: JSON.stringify(body), signal });
    if (!result.ok) {
      const value: unknown = await result.json().catch(() => null);
      send({ event: "error", data: { message: upstreamErrorMessage(value, result.status), status: result.status, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs } });
      return null;
    }
    if (!result.body) throw new Error("The model provider returned an empty stream.");
    const parts: Part[] = [];
    const calls: GeminiFunctionCall[] = [];
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
      send({ event: "error", data: { message: error instanceof Error ? error.message : String(error), status: result.status, finishedAt: new Date().toISOString(), durationMs: Date.now() - startedMs } });
      return null;
    }
    if (process.env.LARGE_FILES_DEBUG === "1") {
      console.log(`[large-files] turn ${label}: calls=${calls.map((call) => call.name).join(",") || "none"} text=${textCharacters} finish=${finishReason ?? "?"} usage=${JSON.stringify(usage)}`);
    }
    return { parts, calls };
  };

  let unanswered = false;
  for (let turn = 1; turn <= maxTurns; turn++) {
    const result = await streamTurn(String(turn));
    if (!result) {
      response.end();
      return;
    }
    if (result.calls.length === 0) break;
    if (turn === maxTurns) {
      unanswered = true;
      break;
    }
    body.contents.push({ role: "model", parts: result.parts });
    const answered: Array<{ call: GeminiFunctionCall; result: ToolResult }> = [];
    for (const call of result.calls) {
      const label = tools.has(call.name) ? tools.describe(call.name, call.args) : call.name;
      send({ event: "activity", data: { text: `${label}…` } });
      const output = await tools.execute(call.name, call.args);
      send({ event: "step", data: { text: `${label}${stepSummary(label, output)}` } });
      answered.push({ call, result: { ...output, tool_turns_left: maxTurns - turn - 1 } });
    }
    body.contents.push(geminiFunctionResponses(answered));
  }

  // Out of turns, or the model went quiet: ask once more with no tools declared at all.
  // (Gemini can ignore functionCallingConfig mode NONE and keep calling tools.)
  if (unanswered || textCharacters === 0) {
    send({ event: "activity", data: { text: "Writing the answer…" } });
    delete body.tools;
    delete body.toolConfig;
    body.contents.push({ role: "user", parts: [{ text: FINAL_ANSWER_REQUEST }] });
    if (!await streamTurn("final")) {
      response.end();
      return;
    }
  }

  if (textCharacters === 0) {
    send({ event: "delta", data: { text: `The model finished without an answer${finishReason ? ` (${finishReason})` : ""}. Try asking more specifically.` } });
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
