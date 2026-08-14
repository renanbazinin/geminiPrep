import type { Response } from "express";
import type { ChatStreamEvent, ChatStreamRequest } from "../../shared/contracts.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import {
  createUpstreamRequest,
  describeUpstreamRequest,
  extractChunkText,
  parseSseJson,
  upstreamErrorMessage,
} from "./upstream.js";

function sendEvent(res: Response, message: ChatStreamEvent): void {
  res.write(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
}

export async function proxyChatStream(options: {
  request: ChatStreamRequest;
  project: string | null;
  response: Response;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const { request, project, response, fetchImpl = fetch, signal } = options;
  const serverStartedMs = Date.now();
  const serverStartedAt = new Date(serverStartedMs).toISOString();
  const vertexToken = request.provider === "vertex" ? await getVertexAccessToken() : undefined;
  const upstream = createUpstreamRequest({
    request,
    project,
    vertexToken,
    geminiApiKey: process.env.GEMINI_API_KEY,
  });
  upstream.init.signal = signal;

  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  sendEvent(response, {
    event: "meta",
    data: {
      provider: request.provider,
      model: request.model,
      ...(request.region ? { region: request.region } : {}),
      startedAt: serverStartedAt,
      providerRequest: describeUpstreamRequest(upstream),
    },
  });

  const upstreamResponse = await fetchImpl(upstream.url, upstream.init);
  if (!upstreamResponse.ok) {
    const value = await upstreamResponse.json().catch(() => null);
    const finishedAt = new Date().toISOString();
    sendEvent(response, {
      event: "error",
      data: {
        message: upstreamErrorMessage(value, upstreamResponse.status),
        status: upstreamResponse.status,
        finishedAt,
        durationMs: Date.now() - serverStartedMs,
      },
    });
    response.end();
    return;
  }
  if (!upstreamResponse.body) throw new Error("The model provider returned an empty stream.");

  let finishReason: string | undefined;
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let chunkCount = 0;
  let textCharacters = 0;
  let firstTokenMs: number | undefined;
  try {
    for await (const chunk of parseSseJson(upstreamResponse.body)) {
      chunkCount += 1;
      if (chunk.error?.message) throw new Error(chunk.error.message);
      const text = extractChunkText(chunk);
      if (text) {
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - serverStartedMs;
        textCharacters += text.length;
        sendEvent(response, { event: "delta", data: { text } });
      }
      finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
      responseId = chunk.responseId ?? responseId;
      usage = chunk.usageMetadata ?? usage;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    sendEvent(response, {
      event: "error",
      data: {
        message: error instanceof Error ? error.message : String(error),
        status: upstreamResponse.status,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - serverStartedMs,
      },
    });
    response.end();
    return;
  }
  const finishedAt = new Date().toISOString();
  sendEvent(response, {
    event: "done",
    data: {
      ...(finishReason ? { finishReason } : {}),
      ...(responseId ? { responseId } : {}),
      ...(usage ? { usage } : {}),
      providerStatus: upstreamResponse.status,
      finishedAt,
      durationMs: Date.now() - serverStartedMs,
      ...(firstTokenMs === undefined ? {} : { timeToFirstTokenMs: firstTokenMs }),
      chunkCount,
      textCharacters,
    },
  });
  response.end();
}
