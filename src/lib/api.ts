import type { IngestEvent } from "llm-large-files";
import type {
  ChatPresentationCard,
  ChatStreamEvent,
  ChatStreamImageData,
  ChatStreamRequest,
  ChatStreamToolData,
  DocumentUploadResult,
  LargeFilesEvent,
  PublicConfig,
  RegionTestConfig,
} from "../../shared/contracts";
import { isChatToolId, normalizeImageMimeType } from "../../shared/chat-tools";

async function responseError(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status}).`;
}

export async function fetchConfig(signal?: AbortSignal): Promise<PublicConfig> {
  const response = await fetch("/api/config", { signal });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<PublicConfig>;
}

export async function fetchRegionConfig(signal?: AbortSignal): Promise<RegionTestConfig> {
  const response = await fetch("/api/tests/regions/config", { signal });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<RegionTestConfig>;
}

/** How far the server is with an upload it reads (npm engine): a stage, and how much of it is done. */
export type UploadProgress = Omit<Extract<IngestEvent, { type: "ingest.progress" }>, "seq" | "runId" | "time" | "type">;

/**
 * The messages of a Server-Sent Events body, one `data` text each (several `data:` lines joined).
 * Lines end with CRLF, CR or LF (a CRLF split between two chunks is still one break), never with
 * other line breaks such as U+2028, which JSON may hold as they are; comments (keep-alives) and
 * messages without data are skipped.
 */
async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      // A CR that ends a chunk may be the first half of a CRLF: it waits for the next chunk (or the end).
      buffer = done ? buffer.replace(/\r\n?/g, "\n") : buffer.replace(/\r\n|\r(?!$)/g, "\n");
      if (done && buffer.trim()) buffer += "\n\n";
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const lines = buffer.slice(0, boundary).split("\n");
        buffer = buffer.slice(boundary + 2);
        const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(line.startsWith("data: ") ? 6 : 5)).join("\n");
        if (data) yield { ...(event ? { event } : {}), data };
        boundary = buffer.indexOf("\n\n");
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Uploads a large file as raw bytes; the server extracts, indexes, and keeps it for a limited time.
 * It asks for the server's progress as Server-Sent Events: a server that sends them (npm engine)
 * reports each stage to `onProgress` and ends with the document or the reason it was not stored.
 * A server that answers with JSON (original engine) is read as before, and so is every HTTP error.
 */
export async function uploadDocument(
  file: Blob,
  name: string,
  mimeType: string,
  options: { onProgress?(progress: UploadProgress): void; signal?: AbortSignal } = {},
): Promise<DocumentUploadResult> {
  const response = await fetch("/api/documents", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(name),
      "X-File-Type": mimeType || "application/octet-stream",
      Accept: "text/event-stream",
    },
    body: file,
    signal: options.signal,
  });
  if (!response.ok) throw new Error(await responseError(response));
  if (!response.headers.get("Content-Type")?.includes("text/event-stream")) return response.json() as Promise<DocumentUploadResult>;
  if (!response.body) throw new Error("The server returned an empty upload answer.");
  for await (const message of sseData(response.body, options.signal)) {
    let event: IngestEvent;
    try {
      event = JSON.parse(message.data) as IngestEvent;
    } catch {
      continue;
    }
    if (event.type === "ingest.progress") {
      options.onProgress?.({
        stage: event.stage,
        done: event.done,
        ...(typeof event.total === "number" ? { total: event.total } : {}),
        unit: event.unit,
      });
    }
    if (event.type === "ingest.finish") return event.document as DocumentUploadResult;
    if (event.type === "ingest.error") {
      throw new Error(typeof event.error?.message === "string" && event.error.message ? event.error.message : `${name} could not be uploaded.`);
    }
  }
  throw new Error(`The upload of ${name} ended before the server said whether it was stored.`);
}

export async function deleteDocument(id: string): Promise<void> {
  await fetch(`/api/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function streamChat(
  request: ChatStreamRequest,
  handlers: {
    onOpen?(response: { status: number; statusText: string; headers: Record<string, string> }): void;
    onMeta?(event: Extract<ChatStreamEvent, { event: "meta" }>["data"]): void;
    onDelta(text: string): void;
    onThinking?(text: string): void;
    onActivity?(text: string): void;
    onStep?(text: string): void;
    /** What the large-file library does, as typed events (npm engine), beside `onActivity` and `onStep`. */
    onLargeFiles?(event: LargeFilesEvent): void;
    onGrounding?(data: Extract<ChatStreamEvent, { event: "grounding" }>["data"]): void;
    onImage?(image: ChatStreamImageData): void | Promise<void>;
    onTool?(tool: ChatStreamToolData): void | Promise<void>;
    onPresentation?(card: ChatPresentationCard): void;
    onDone?(event: Extract<ChatStreamEvent, { event: "done" }>["data"]): void;
    onError?(event: Extract<ChatStreamEvent, { event: "error" }>["data"]): void;
  },
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  handlers.onOpen?.({
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  });
  if (!response.ok) {
    const message = await responseError(response);
    handlers.onError?.({ message, status: response.status });
    throw new Error(message);
  }
  if (!response.body) throw new Error("The server returned an empty stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalEvent = false;
  try {
  while (true) {
    const { value, done } = await reader.read();
    signal.throwIfAborted();
    buffer += decoder.decode(value, { stream: !done });
    buffer = buffer.replace(/\r\n/g, "\n");
    if (done && buffer.trim()) buffer += "\n\n";
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventName = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
      const dataText = block.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (eventName && dataText) {
        const data = JSON.parse(dataText) as Record<string, unknown>;
        if (eventName === "meta") handlers.onMeta?.(data as never);
        if (eventName === "delta" && typeof data.text === "string") handlers.onDelta(data.text);
        if (eventName === "thinking" && typeof data.text === "string") handlers.onThinking?.(data.text);
        if (eventName === "activity" && typeof data.text === "string") handlers.onActivity?.(data.text);
        if (eventName === "step" && typeof data.text === "string") handlers.onStep?.(data.text);
        if (eventName === "largeFiles" && typeof data.type === "string") handlers.onLargeFiles?.(data as unknown as LargeFilesEvent);
        if (eventName === "grounding") handlers.onGrounding?.(data as Extract<ChatStreamEvent, { event: "grounding" }>["data"]);
        if (eventName === "image" && typeof data.mimeType === "string" && typeof data.data === "string") {
          const mimeType = normalizeImageMimeType(data.mimeType) ?? (data.mimeType.startsWith("image/") ? "image/png" : null);
          if (mimeType) await handlers.onImage?.({ mimeType, data: data.data });
        }
        if (eventName === "tool" && isChatToolId(data.id) && typeof data.name === "string") {
          const args = data.args && typeof data.args === "object" && !Array.isArray(data.args)
            ? data.args as Record<string, unknown>
            : {};
          await handlers.onTool?.({
            id: data.id,
            name: data.name,
            args,
            ...(typeof data.model === "string" ? { model: data.model } : {}),
            ...(typeof data.region === "string" ? { region: data.region } : {}),
          });
        }
        if (eventName === "presentation" && typeof data.id === "string" && typeof data.context === "string"
          && Array.isArray(data.slides) && (data.kind === "plan" || data.kind === "deck")) {
          handlers.onPresentation?.(data as unknown as ChatPresentationCard);
        }
        if (eventName === "done") {
          terminalEvent = true;
          handlers.onDone?.(data as never);
          return;
        }
        if (eventName === "error") {
          terminalEvent = true;
          const error = {
            message: typeof data.message === "string" ? data.message : "Streaming request failed.",
            ...(typeof data.status === "number" ? { status: data.status } : {}),
            ...(typeof data.finishedAt === "string" ? { finishedAt: data.finishedAt } : {}),
            ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
            ...(data.code === "interaction_reference_invalid" ? { code: "interaction_reference_invalid" as const } : {}),
          };
          handlers.onError?.(error);
          throw new Error(error.message);
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (!terminalEvent) throw new Error("The stream ended before the model completed its response.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
