import type { Response } from "express";
import type { ChatStreamEvent, ChatStreamRequest } from "../../shared/contracts.js";
import { normalizeImageMimeType, resolvedChatSystemInstruction } from "../../shared/chat-tools.js";
import { describeUpstreamRequest, parseSseJson, upstreamErrorMessage } from "./upstream.js";
import { isInteractionAccessError, isInvalidInteractionReference } from "./interaction-errors.js";
import { getVertexAccessToken } from "../vertex-auth.js";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

export function interactionInput(messages: ChatStreamRequest["messages"]): RecordValue[] {
  return messages.map((message) => ({
    type: message.role === "user" ? "user_input" : "model_output",
    content: [
      ...(message.content ? [{ type: "text", text: message.content }] : []),
      ...(message.files ?? []).map((file) => file.kind === "text"
        ? { type: "text", text: `Attached file: ${file.name}\n${file.text}` }
        : { type: file.mimeType === "application/pdf" ? "document" : "image", mime_type: file.mimeType, data: file.data }),
    ],
  }));
}

export function buildInteractionBody(request: ChatStreamRequest): RecordValue {
  const options = request.interactions!;
  const image = request.tool === "image";
  const vertex = request.provider === "vertex";
  const tools = image ? [] : [
    ...(options.googleSearch ? [{ type: "google_search" }] : []),
    ...(options.urlContext ? [{ type: "url_context" }] : []),
    ...(options.codeExecution ? [{ type: "code_execution" }] : []),
  ];
  return {
    model: request.model,
    input: interactionInput(request.messages),
    stream: true,
    store: options.store,
    ...(request.previousInteractionId ? { previous_interaction_id: request.previousInteractionId } : {}),
    ...(resolvedChatSystemInstruction(request) ? { system_instruction: resolvedChatSystemInstruction(request) } : {}),
    ...(tools.length ? { tools } : {}),
    generation_config: {
      max_output_tokens: request.maxOutputTokens,
      ...(options.seed !== null ? { seed: options.seed } : {}),
      ...(options.stopSequences.length ? { stop_sequences: options.stopSequences } : {}),
      ...(!image ? {
        thinking_summaries: options.thinkingSummaries,
        ...(options.thinkingLevel !== "default" ? { thinking_level: options.thinkingLevel } : {}),
      } : {}),
      ...(tools.length ? { tool_choice: options.toolChoice } : {}),
      // Sampling controls are deprecated in beta and absent from the stable v1 schema.
      ...(vertex || options.apiVersion === "v1beta" ? {
        temperature: request.temperature,
        ...(options.topP !== null ? { top_p: options.topP } : {}),
      } : {}),
      ...(vertex && image ? { image_config: { aspect_ratio: options.imageAspectRatio, image_size: options.imageSize } } : {}),
    },
    ...(vertex ? (image ? { response_modalities: ["text", "image"] } : options.responseFormat === "json" ? {
      response_mime_type: "application/json",
      ...(options.responseSchema.trim() ? { response_format: JSON.parse(options.responseSchema) } : {}),
    } : {}) : image ? { response_format: [
      { type: "text" },
      { type: "image", delivery: "inline", aspect_ratio: options.imageAspectRatio, image_size: options.imageSize },
    ] } : options.responseFormat === "json" ? {
      response_format: { type: "text", mime_type: "application/json",
        ...(options.responseSchema.trim() ? { schema: JSON.parse(options.responseSchema) } : {}),
      },
    } : {}),
  };
}

export async function proxyInteractionStream(options: {
  request: ChatStreamRequest;
  project: string | null;
  response: Response;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const { request, project, response, fetchImpl = fetch, signal } = options;
  const vertex = request.provider === "vertex";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (vertex) {
    if (!project) throw new Error("No Google Cloud project is configured for Vertex Interactions.");
    if (request.interactionProject && request.interactionProject !== project) {
      response.status(409).json({ error: "The Google Cloud project changed. Reload the page to rebuild this conversation for the current project." });
      return;
    }
    headers.Authorization = `Bearer ${await getVertexAccessToken()}`;
  } else {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured on the server.");
    headers["x-goog-api-key"] = process.env.GEMINI_API_KEY;
  }
  signal?.throwIfAborted();
  const started = Date.now();
  const upstream = {
    url: vertex ? `https://aiplatform.googleapis.com/v1beta1/projects/${encodeURIComponent(project!)}/locations/global/interactions`
      : `https://generativelanguage.googleapis.com/${request.interactions!.apiVersion}/interactions`,
    init: {
      method: "POST", headers,
      body: JSON.stringify(buildInteractionBody(request)), signal,
    },
  };
  response.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
  response.flushHeaders();
  const send = (event: ChatStreamEvent) => {
    if (!signal?.aborted && !response.writableEnded) response.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  };
  send({ event: "meta", data: { provider: request.provider, ...(vertex ? { region: "global" } : {}), api: "interactions", model: request.model, startedAt: new Date(started).toISOString(), providerRequest: describeUpstreamRequest(upstream) } });
  let chunkCount = 0;
  let textCharacters = 0;
  let firstTokenMs: number | undefined;
  let interactionId: string | undefined;
  let interactionStatus: string | undefined;
  let usage: RecordValue | undefined;
  let completed = false;
  const stepTypes = new Map<number, string>();
  const images = new Map<number, { data: string; mimeType: string }>();
  const sourceUrls = new Set<string>();
  const suggestions = new Set<string>();
  const emitGrounding = (value: RecordValue) => {
    if (Array.isArray(value.annotations)) {
      const sources: Array<{ title: string; url: string }> = [];
      for (const candidate of value.annotations) {
        const annotation = record(candidate);
        if (annotation.type !== "url_citation" || typeof annotation.url !== "string" || !/^https?:\/\//i.test(annotation.url) || sourceUrls.has(annotation.url)) continue;
        sourceUrls.add(annotation.url);
        sources.push({ url: annotation.url, title: typeof annotation.title === "string" ? annotation.title : annotation.url });
      }
      if (sources.length) send({ event: "grounding", data: { sources } });
    }
    if (value.type === "google_search_result" && Array.isArray(value.result)) {
      for (const result of value.result) {
        const html = record(result).search_suggestions;
        if (typeof html === "string" && html && !suggestions.has(html)) {
          suggestions.add(html);
          send({ event: "grounding", data: { searchSuggestions: html } });
        }
      }
    }
  };
  const emitText = (text: string, thinking = false) => {
    if (!text) return;
    if (!thinking) {
      firstTokenMs ??= Date.now() - started;
      textCharacters += text.length;
    }
    send({ event: thinking ? "thinking" : "delta", data: { text } });
  };
  const flushImage = (index: number) => {
    const image = images.get(index);
    if (!image) return;
    const mimeType = normalizeImageMimeType(image.mimeType);
    if (!mimeType) throw new Error(`Unsupported image format: ${image.mimeType}`);
    firstTokenMs ??= Date.now() - started;
    send({ event: "image", data: { mimeType, data: image.data } });
    images.delete(index);
  };
  try {
    const result = await fetchImpl(upstream.url, upstream.init);
    if (!result.ok) {
      const value: unknown = await result.json().catch(() => null);
      const message = upstreamErrorMessage(value, result.status);
      let invalidReference = Boolean(request.previousInteractionId && isInvalidInteractionReference(result.status, value));
      // Google can report a bad ID as a generic INVALID_ARGUMENT. Check the resource
      // rather than confusing model/option errors with expired conversation state.
      if (!invalidReference && !isInteractionAccessError(value) && request.previousInteractionId && [400, 404, 410].includes(result.status)) {
        send({ event: "activity", data: { text: "Checking the saved conversation…" } });
        try {
          const reference = await fetchImpl(`${upstream.url}/${encodeURIComponent(request.previousInteractionId)}${vertex ? "" : "?include_input=false"}`, {
            method: "GET", headers: upstream.init.headers, signal,
          });
          invalidReference = [400, 404, 410].includes(reference.status);
          if (reference.status === 400) {
            const referenceError: unknown = await reference.json().catch(() => null);
            if (isInteractionAccessError(referenceError)) invalidReference = false;
          }
          await reference.body?.cancel().catch(() => undefined);
        } catch (error) {
          if (signal?.aborted) throw error;
          // An unavailable network is not evidence that the saved reference expired.
        }
      }
      send({ event: "error", data: { status: result.status, message,
        ...(invalidReference ? { code: "interaction_reference_invalid" as const } : {}),
      } });
      return;
    }
    if (!result.body) throw new Error("Gemini returned an empty interaction stream.");
    for await (const event of parseSseJson<RecordValue>(result.body)) {
      if (signal?.aborted) return;
      chunkCount++;
      const type = event.event_type;
      const interaction = record(event.interaction);
      if (typeof interaction.id === "string") interactionId = interaction.id;
      if (interaction.usage) usage = record(interaction.usage);
      if (event.usage) usage = record(event.usage);
      const metadataUsage = record(event.metadata).total_usage;
      if (metadataUsage) usage = record(metadataUsage);
      if (type === "error") throw new Error(String(record(event.error).message ?? "Gemini interaction failed."));
      const index = typeof event.index === "number" ? event.index : 0;
      if (type === "step.start") {
        const step = record(event.step);
        emitGrounding(step);
        stepTypes.set(index, String(step.type));
        const names: Record<string, string> = { google_search_call: "Searching the web…", url_context_call: "Reading web pages…", code_execution_call: "Running code…", thought: "Thinking…" };
        const activity = names[String(step.type)];
        if (activity) send({ event: "activity", data: { text: activity } });
        if (step.type === "thought" && request.interactions!.thinkingSummaries === "auto" && Array.isArray(step.summary)) {
          for (const summary of step.summary) {
            const content = record(summary);
            if (content.type === "text" && typeof content.text === "string") emitText(content.text, true);
          }
        }
        if (step.type === "model_output" && Array.isArray(step.content)) {
          for (const content of step.content) {
            const part = record(content);
            emitGrounding(part);
            if (part.type === "text" && typeof part.text === "string") emitText(part.text);
            if (part.type === "image" && typeof part.data === "string") {
              images.set(index, { data: part.data, mimeType: String(part.mime_type ?? "image/png") });
              flushImage(index);
            }
          }
        }
      }
      if (type === "step.delta") {
        const delta = record(event.delta);
        emitGrounding(delta);
        if (delta.type === "text" && typeof delta.text === "string" && stepTypes.get(index) === "model_output") emitText(delta.text);
        if (delta.type === "thought_summary" && request.interactions!.thinkingSummaries === "auto") {
          const content = record(delta.content);
          if (content.type === "text" && typeof content.text === "string") emitText(content.text, true);
        }
        if (delta.type === "image" && typeof delta.data === "string") {
          const previous = images.get(index);
          images.set(index, { data: (previous?.data ?? "") + delta.data, mimeType: String(delta.mime_type ?? previous?.mimeType ?? "image/png") });
        }
      }
      if (type === "step.stop") flushImage(index);
      if (type === "interaction.completed") {
        if (Array.isArray(interaction.steps)) {
          for (const candidate of interaction.steps) {
            const step = record(candidate);
            emitGrounding(step);
            if (Array.isArray(step.content)) for (const content of step.content) emitGrounding(record(content));
          }
        }
        interactionStatus = typeof interaction.status === "string" ? interaction.status : undefined;
        if (interactionStatus !== "completed" && interactionStatus !== "incomplete") {
          throw new Error(`Gemini interaction ended with status ${interactionStatus ?? "unknown"}.`);
        }
        if (!interactionId && request.interactions!.store && interactionStatus === "completed") throw new Error("Gemini completed without an interaction ID.");
        completed = true;
        break;
      }
      if (type === "interaction.status_update" && ["failed", "cancelled"].includes(String(event.status))) {
        throw new Error(`Gemini interaction ${event.status}.`);
      }
    }
    if (!completed) throw new Error("The interaction stream ended before completion. Retry this turn.");
    for (const index of images.keys()) flushImage(index);
    send({ event: "done", data: {
      ...(request.interactions!.store && interactionStatus === "completed" ? { interactionId, ...(vertex ? { interactionProject: project! } : {}) } : {}),
      responseId: interactionId, interactionStatus,
      finishReason: interactionStatus === "incomplete" ? "MAX_TOKENS" : "STOP",
      usage, providerStatus: result.status, finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
      timeToFirstTokenMs: firstTokenMs, chunkCount, textCharacters,
    } });
  } catch (error) {
    if (!signal?.aborted) send({ event: "error", data: { message: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString(), durationMs: Date.now() - started } });
  } finally {
    response.end();
  }
}
