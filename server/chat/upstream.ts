import type { ChatStreamImageData, ChatStreamRequest, DebugHttpExchange } from "../../shared/contracts.js";
import { compactDebugValue } from "../../shared/debug.js";
import { chatFunctionDeclarations, normalizeImageMimeType, resolvedChatSystemInstruction } from "../../shared/chat-tools.js";
import { vertexGenerateContentUrl } from "../region-probe.js";

type UpstreamInlineData = {
  mimeType?: unknown;
  data?: unknown;
};

type UpstreamFunctionCall = {
  name?: unknown;
  args?: unknown;
};

type UpstreamChunk = {
  candidates?: Array<{
    content?: { parts?: Array<{
      text?: unknown;
      thought?: boolean;
      inlineData?: UpstreamInlineData;
      functionCall?: UpstreamFunctionCall;
    }> };
    finishReason?: string;
  }>;
  usageMetadata?: Record<string, unknown>;
  responseId?: string;
  error?: { message?: string; code?: number };
};

export function geminiStreamUrl(model: string, apiVersion = "v1beta"): string {
  return `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:streamGenerateContent?alt=sse`;
}

function contentParts(message: ChatStreamRequest["messages"][number]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (message.content.trim()) parts.push({ text: message.content });
  for (const file of message.files ?? []) {
    if (file.kind === "text") {
      parts.push({
        text: `\n\n--- Attached file: ${file.name} (${file.mimeType}) ---\n${file.text}\n--- End attached file: ${file.name} ---`,
      });
      continue;
    }
    if (file.mimeType === "application/pdf") {
      parts.push({ text: `Attached PDF: ${file.name}` });
    }
    parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  }
  return parts.length > 0 ? parts : [{ text: "" }];
}

export function buildGenerateContentBody(request: ChatStreamRequest): Record<string, unknown> {
  const systemInstruction = resolvedChatSystemInstruction(request);
  const autoRoute = !request.tool;
  const cachedContent = autoRoute ? undefined : request.cachedContent;
  return {
    contents: request.messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: contentParts(message),
    })),
    // A cache carries its own system instruction, and Vertex rejects a second one alongside it.
    ...(systemInstruction && !cachedContent
      ? { systemInstruction: { role: "system", parts: [{ text: systemInstruction }] } }
      : {}),
    ...(cachedContent ? { cachedContent } : {}),
    ...(autoRoute
      ? {
          tools: [{ functionDeclarations: chatFunctionDeclarations() }],
          toolConfig: { functionCallingConfig: { mode: "AUTO" } },
        }
      : {}),
    generationConfig: {
      temperature: request.temperature,
      maxOutputTokens: request.maxOutputTokens,
      ...(request.thinkingLevel ? { thinkingConfig: { thinkingLevel: request.thinkingLevel } } : {}),
      ...(request.tool === "image" ? { responseModalities: ["TEXT", "IMAGE"] } : {}),
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
    ...(body === undefined ? {} : {
      body: compactDebugValue(body, { maxStringCharacters: 4_000, maxArrayItems: 40 }),
    }),
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

export function extractChunkImages(chunk: UpstreamChunk): ChatStreamImageData[] {
  const images: ChatStreamImageData[] = [];
  for (const candidate of chunk.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const inline = part.inlineData;
      if (!inline || typeof inline.data !== "string" || !inline.data) continue;
      const mimeType = typeof inline.mimeType === "string" ? inline.mimeType : "image/png";
      const normalized = normalizeImageMimeType(mimeType) ?? (mimeType.startsWith("image/") ? "image/png" : null);
      if (!normalized) continue;
      images.push({ mimeType: normalized, data: inline.data });
    }
  }
  return images;
}

export type ExtractedFunctionCall = {
  name: string;
  args: Record<string, unknown>;
};

function asArgs(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function extractChunkFunctionCalls(chunk: UpstreamChunk): ExtractedFunctionCall[] {
  const calls: ExtractedFunctionCall[] = [];
  for (const candidate of chunk.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const call = part.functionCall;
      if (!call || typeof call.name !== "string" || !call.name.trim()) continue;
      calls.push({ name: call.name, args: asArgs(call.args) });
    }
  }
  return calls;
}

export function mergeFunctionCall(
  current: ExtractedFunctionCall | undefined,
  next: ExtractedFunctionCall[],
): ExtractedFunctionCall | undefined {
  let merged = current;
  for (const call of next) {
    merged = merged && call.name === merged.name
      ? { name: call.name, args: { ...merged.args, ...call.args } }
      : call;
  }
  return merged;
}

export function upstreamErrorMessage(value: unknown, status: number): string {
  const parsed = value as { error?: { message?: unknown } } | null;
  if (typeof parsed?.error?.message === "string") return parsed.error.message;
  return `The model provider returned HTTP ${status}.`;
}

export type { UpstreamChunk };
