import type { Response } from "express";
import type { LargeFiles } from "llm-large-files";
import { askGemini, GeminiRequestError, type GeminiContent } from "llm-large-files/gemini";
import type { ChatStreamEvent, ChatStreamRequest } from "../../shared/contracts.js";
import { gemini4OutputTokens, isGemini4Model } from "../../shared/gemini-4.js";
import { resolveLargeFilesSettings } from "../documents/config.js";
import { toGenerateContentUrl } from "../special-group/model-loop.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import { createUpstreamRequest, describeUpstreamRequest } from "./upstream.js";

type UpstreamBody = {
  contents: GeminiContent[];
  systemInstruction?: { parts?: Array<{ text?: string }> };
  generationConfig?: Record<string, unknown>;
  tools?: unknown;
  toolConfig?: unknown;
};

function documentIds(request: ChatStreamRequest): string[] {
  return request.messages.flatMap((message) => (message.files ?? [])
    .flatMap((file) => (file.kind === "document" ? [file.documentId] : [])));
}

/**
 * Takes the document references out of the history. askGemini puts each file's text or card at the
 * start of the first user message, where it stays as the conversation grows (so Gemini's prompt
 * cache can reuse it). A file attached in a later message leaves a short note where it was.
 */
export function withoutDocuments(request: ChatStreamRequest): ChatStreamRequest {
  const first = request.messages.findIndex((message) => message.role === "user");
  return {
    ...request,
    messages: request.messages.map((message, index) => {
      const documents = (message.files ?? []).filter((file) => file.kind === "document");
      if (documents.length === 0) return message;
      const rest = (message.files ?? []).filter((file) => file.kind !== "document");
      const notes = index === first ? [] : documents.map((file) => `(Attached file: ${file.name}. Its text or summary card is at the start of this conversation.)`);
      return {
        role: message.role,
        content: [message.content, ...notes].filter((text) => text.trim()).join("\n\n"),
        ...(rest.length ? { files: rest } : {}),
      };
    }),
  };
}

/**
 * The npm engine's tool loop: llm-large-files' askGemini, streamed to the browser with the same
 * events as the original loop (meta, activity, step, delta, done, error).
 */
export async function streamWithPackage(options: {
  request: ChatStreamRequest;
  project: string | null;
  response: Response;
  files: LargeFiles;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const { project, response, files, signal, fetchImpl = fetch } = options;
  // Tool calling runs on Generate Content, whichever chat API is selected.
  const { interactions: _i, interactionProject: _p, previousInteractionId: _id, cachedContent: _c, ...request } = options.request;
  const startedMs = Date.now();
  const vertexToken = request.provider === "vertex" ? await getVertexAccessToken() : undefined;
  const upstream = createUpstreamRequest({ request: withoutDocuments(request), project, vertexToken, geminiApiKey: process.env.GEMINI_API_KEY });
  const headers = upstream.init.headers as Record<string, string>;
  const body = JSON.parse(upstream.init.body as string) as UpstreamBody;
  // Only the document tools, which askGemini declares: an image or diagram specialist could not see what they found.
  delete body.tools;
  delete body.toolConfig;
  // A message that was only a file has an empty text part, which Gemini refuses. In the first user
  // message askGemini puts the text of the files in its place; a later one holds the note above.
  const first = body.contents.find((content) => content.role === "user");
  if (first) first.parts = first.parts.filter((part) => !(Object.keys(part).length === 1 && typeof part.text === "string" && !part.text.trim()));

  const send = (event: ChatStreamEvent) => {
    if (!signal?.aborted && !response.writableEnded) response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
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

  const gemini4 = isGemini4Model(request.model);
  const settings = resolveLargeFilesSettings();
  let textCharacters = 0;
  let deltaCount = 0;
  let firstTokenMs: number | undefined;
  try {
    const result = await askGemini({
      files,
      endpoint: { url: toGenerateContentUrl(upstream.url), streamUrl: upstream.url, headers },
      documentIds: documentIds(request),
      contents: body.contents,
      system: body.systemInstruction?.parts?.map((part) => part.text ?? "").join("\n") || undefined,
      ...(body.generationConfig ? { generationConfig: body.generationConfig } : {}),
      // The most requests for one answer, the last of them without tools.
      maxToolTurns: settings.maxToolTurns,
      // view_pages: the model asks for pages of a kept PDF and gets them as a small PDF.
      viewPages: settings.keepPdfs,
      toolFilePlacement: settings.pagePlacement,
      analysisConfig: (maxOutputTokens) => ({
        ...(gemini4 ? {} : { temperature: 0.2 }),
        maxOutputTokens: gemini4 ? gemini4OutputTokens(maxOutputTokens) : maxOutputTokens,
        ...(request.thinkingLevel ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
      }),
      onText: (text) => {
        deltaCount++;
        firstTokenMs ??= Date.now() - startedMs;
        textCharacters += text.length;
        send({ event: "delta", data: { text } });
      },
      onActivity: (text) => send({ event: "activity", data: { text } }),
      onStep: (text) => send({ event: "step", data: { text } }),
      fetch: fetchImpl,
      ...(signal ? { signal } : {}),
    });
    if (process.env.LARGE_FILES_DEBUG === "1") {
      console.log(`[large-files npm] turns=${result.turns} steps=${result.steps.length} text=${result.text.length} finish=${result.finishReason ?? "?"} usage=${JSON.stringify(result.usage)}`);
    }
    // No answer: the prompt was blocked, or the last turn came back empty. Text from before a tool
    // call ("Let me check…") may already be on screen; it is not the answer.
    if (!result.answered) {
      const reason = result.blockReason
        ? `The request was blocked (${result.blockReason}).`
        : `The model finished without an answer${result.finishReason ? ` (${result.finishReason})` : ""}. Try asking more specifically.`;
      send({ event: "delta", data: { text: `${result.text.trim() ? "\n\n" : ""}${reason}` } });
    }
    send({ event: "done", data: {
      ...(result.finishReason ? { finishReason: result.finishReason } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      providerStatus: 200,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      ...(firstTokenMs === undefined ? {} : { timeToFirstTokenMs: firstTokenMs }),
      chunkCount: deltaCount,
      textCharacters,
    } });
  } catch (error) {
    if (signal?.aborted) throw error;
    send({ event: "error", data: {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof GeminiRequestError ? { status: error.status } : {}),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
    } });
  }
  response.end();
}
