import type { ChatStreamRequest, DebugHttpExchange } from "../../shared/contracts.js";
import { vertexGenerateContentUrl } from "../region-probe.js";

type UpstreamChunk = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: unknown; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: Record<string, unknown>;
  responseId?: string;
  error?: { message?: string; code?: number };
};

export function geminiStreamUrl(model: string, apiVersion = "v1beta"): string {
  return `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:streamGenerateContent?alt=sse`;
}

export function buildGenerateContentBody(request: ChatStreamRequest): Record<string, unknown> {
  return {
    contents: request.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
    ...(request.systemInstruction
      ? { systemInstruction: { role: "system", parts: [{ text: request.systemInstruction }] } }
      : {}),
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
    },
  };
}

export function createUpstreamRequest(options: {
  request: ChatStreamRequest;
  project: string | null;
  vertexToken?: string;
  geminiApiKey?: string;
}): { url: string; init: RequestInit } {
  const { request } = options;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string;
  if (request.provider === "vertex") {
    if (!options.project) throw new Error("No Google Cloud project is configured for Vertex AI.");
    if (!options.vertexToken) throw new Error("No Vertex AI access token is available.");
    headers.Authorization = `Bearer ${options.vertexToken}`;
    url = vertexGenerateContentUrl({
      project: options.project,
      region: request.region ?? "global",
      model: request.model,
      stream: true,
    });
  } else {
    if (!options.geminiApiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");
    headers["x-goog-api-key"] = options.geminiApiKey;
    url = geminiStreamUrl(request.model, process.env.GEMINI_API_VERSION || "v1beta");
  }
  return {
    url,
    init: { method: "POST", headers, body: JSON.stringify(buildGenerateContentBody(request)) },
  };
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-goog-api-key",
]);

export function describeUpstreamRequest(
  upstream: { url: string; init: RequestInit },
): DebugHttpExchange {
  const headers = new Headers(upstream.init.headers);
  const safeHeaders: Record<string, string> = {};
  headers.forEach((value, name) => {
    safeHeaders[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? "[REDACTED]" : value;
  });
  const url = new URL(upstream.url);
  for (const name of ["key", "api_key", "access_token", "token"]) {
    if (url.searchParams.has(name)) url.searchParams.set(name, "[REDACTED]");
  }
  let body: unknown;
  if (typeof upstream.init.body === "string") {
    try {
      body = JSON.parse(upstream.init.body) as unknown;
    } catch {
      body = upstream.init.body;
    }
  }
  return {
    method: upstream.init.method ?? "GET",
    url: url.toString(),
    headers: safeHeaders,
    ...(body === undefined ? {} : { body }),
  };
}

export async function* parseSseJson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<UpstreamChunk> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data && data !== "[DONE]") {
          yield JSON.parse(data) as UpstreamChunk;
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
    const trailing = buffer.trim();
    if (trailing.startsWith("data:")) {
      const data = trailing.slice(5).trim();
      if (data && data !== "[DONE]") yield JSON.parse(data) as UpstreamChunk;
    }
  } finally {
    reader.releaseLock();
  }
}

export function extractChunkText(chunk: UpstreamChunk): string {
  return (chunk.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .filter((part) => part.thought !== true && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

export function upstreamErrorMessage(value: unknown, status: number): string {
  const parsed = value as { error?: { message?: unknown } } | null;
  if (typeof parsed?.error?.message === "string") return parsed.error.message;
  return `The model provider returned HTTP ${status}.`;
}

export type { UpstreamChunk };
