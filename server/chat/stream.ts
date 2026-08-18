import type { Response } from "express";
import type { ChatStreamEvent, ChatStreamRequest } from "../../shared/contracts.js";
import { handoffForFunctionCall, specialistRequestFromHandoff } from "../../shared/chat-tools.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import {
  createUpstreamRequest,
  describeUpstreamRequest,
  extractChunkFunctionCalls,
  extractChunkImages,
  extractChunkText,
  mergeFunctionCall,
  parseSseJson,
  upstreamErrorMessage,
  type ExtractedFunctionCall,
} from "./upstream.js";

function sendEvent(res: Response, message: ChatStreamEvent): void {
  res.write(`event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`);
}

type HopResult = {
  ok: boolean;
  status: number;
  finishReason?: string;
  responseId?: string;
  usage?: Record<string, unknown>;
  chunkCount: number;
  textCharacters: number;
  firstTokenMs?: number;
  functionCall?: ExtractedFunctionCall;
};

async function streamUpstreamHop(options: {
  request: ChatStreamRequest;
  project: string | null;
  vertexToken?: string;
  response: Response;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  serverStartedMs: number;
  collectFunctionCalls: boolean;
}): Promise<HopResult> {
  const upstream = createUpstreamRequest({
    request: options.request,
    project: options.project,
    vertexToken: options.vertexToken,
    geminiApiKey: process.env.GEMINI_API_KEY,
  });
  upstream.init.signal = options.signal;
  const upstreamResponse = await options.fetchImpl(upstream.url, upstream.init);
  if (!upstreamResponse.ok) {
    const value = await upstreamResponse.json().catch(() => null);
    const finishedAt = new Date().toISOString();
    sendEvent(options.response, {
      event: "error",
      data: {
        message: upstreamErrorMessage(value, upstreamResponse.status),
        status: upstreamResponse.status,
        finishedAt,
        durationMs: Date.now() - options.serverStartedMs,
      },
    });
    return { ok: false, status: upstreamResponse.status, chunkCount: 0, textCharacters: 0 };
  }
  if (!upstreamResponse.body) throw new Error("The model provider returned an empty stream.");

  let finishReason: string | undefined;
  let responseId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  let chunkCount = 0;
  let textCharacters = 0;
  let firstTokenMs: number | undefined;
  let functionCall: ExtractedFunctionCall | undefined;
  try {
    for await (const chunk of parseSseJson(upstreamResponse.body)) {
      chunkCount += 1;
      if (chunk.error?.message) throw new Error(chunk.error.message);
      const text = extractChunkText(chunk);
      if (text) {
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - options.serverStartedMs;
        textCharacters += text.length;
        sendEvent(options.response, { event: "delta", data: { text } });
      }
      for (const image of extractChunkImages(chunk)) {
        if (firstTokenMs === undefined) firstTokenMs = Date.now() - options.serverStartedMs;
        sendEvent(options.response, { event: "image", data: image });
      }
      if (options.collectFunctionCalls) {
        functionCall = mergeFunctionCall(functionCall, extractChunkFunctionCalls(chunk));
      }
      finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
      responseId = chunk.responseId ?? responseId;
      usage = chunk.usageMetadata ?? usage;
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    sendEvent(options.response, {
      event: "error",
      data: {
        message: error instanceof Error ? error.message : String(error),
        status: upstreamResponse.status,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - options.serverStartedMs,
      },
    });
    return { ok: false, status: upstreamResponse.status, chunkCount, textCharacters, firstTokenMs };
  }
  return {
    ok: true,
    status: upstreamResponse.status,
    ...(finishReason ? { finishReason } : {}),
    ...(responseId ? { responseId } : {}),
    ...(usage ? { usage } : {}),
    chunkCount,
    textCharacters,
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    ...(functionCall ? { functionCall } : {}),
  };
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
  const plannerUpstream = createUpstreamRequest({
    request,
    project,
    vertexToken,
    geminiApiKey: process.env.GEMINI_API_KEY,
  });

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
      providerRequest: describeUpstreamRequest(plannerUpstream),
    },
  });

  const planner = await streamUpstreamHop({
    request,
    project,
    vertexToken,
    response,
    fetchImpl,
    signal,
    serverStartedMs,
    collectFunctionCalls: !request.tool,
  });
  if (!planner.ok) {
    response.end();
    return;
  }

  let hop = planner;
  const handoff = planner.functionCall
    ? handoffForFunctionCall(planner.functionCall.name)
    : undefined;
  if (handoff && planner.functionCall) {
    const specialist = specialistRequestFromHandoff(request, handoff, planner.functionCall.args);
    sendEvent(response, {
      event: "tool",
      data: {
        id: handoff.toolId,
        name: planner.functionCall.name,
        args: planner.functionCall.args,
        model: specialist.model,
        ...(specialist.region ? { region: specialist.region } : {}),
      },
    });
    hop = await streamUpstreamHop({
      request: specialist,
      project,
      vertexToken,
      response,
      fetchImpl,
      signal,
      serverStartedMs,
      collectFunctionCalls: false,
    });
    if (!hop.ok) {
      response.end();
      return;
    }
  }

  const finishedAt = new Date().toISOString();
  sendEvent(response, {
    event: "done",
    data: {
      ...(hop.finishReason ? { finishReason: hop.finishReason } : {}),
      ...(hop.responseId ? { responseId: hop.responseId } : {}),
      ...(hop.usage ? { usage: hop.usage } : {}),
      providerStatus: hop.status,
      finishedAt,
      durationMs: Date.now() - serverStartedMs,
      ...(hop.firstTokenMs === undefined && planner.firstTokenMs === undefined
        ? {}
        : { timeToFirstTokenMs: planner.firstTokenMs ?? hop.firstTokenMs }),
      chunkCount: planner.chunkCount + (hop === planner ? 0 : hop.chunkCount),
      textCharacters: planner.textCharacters + (hop === planner ? 0 : hop.textCharacters),
    },
  });
  response.end();
}
