import type {
  ChatStreamEvent,
  ChatStreamImageData,
  ChatStreamRequest,
  ChatStreamToolData,
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

export async function streamChat(
  request: ChatStreamRequest,
  handlers: {
    onOpen?(response: { status: number; statusText: string; headers: Record<string, string> }): void;
    onMeta?(event: Extract<ChatStreamEvent, { event: "meta" }>["data"]): void;
    onDelta(text: string): void;
    onImage?(image: ChatStreamImageData): void | Promise<void>;
    onTool?(tool: ChatStreamToolData): void | Promise<void>;
    onDone?(event: Extract<ChatStreamEvent, { event: "done" }>["data"]): void;
    onError?(event: Extract<ChatStreamEvent, { event: "error" }>["data"]): void;
  },
  signal: AbortSignal,
): Promise<void> {
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
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
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
        if (eventName === "done") {
          terminalEvent = true;
          handlers.onDone?.(data as never);
        }
        if (eventName === "error") {
          terminalEvent = true;
          const error = {
            message: typeof data.message === "string" ? data.message : "Streaming request failed.",
            ...(typeof data.status === "number" ? { status: data.status } : {}),
            ...(typeof data.finishedAt === "string" ? { finishedAt: data.finishedAt } : {}),
            ...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
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
}
