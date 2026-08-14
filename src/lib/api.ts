import type {
  ChatStreamEvent,
  ChatStreamRequest,
  PublicConfig,
  RegionTestConfig,
} from "../../shared/contracts";

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
    onMeta?(event: Extract<ChatStreamEvent, { event: "meta" }>["data"]): void;
    onDelta(text: string): void;
    onDone?(event: Extract<ChatStreamEvent, { event: "done" }>["data"]): void;
  },
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw new Error(await responseError(response));
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
        if (eventName === "done") {
          terminalEvent = true;
          handlers.onDone?.(data as never);
        }
        if (eventName === "error") {
          terminalEvent = true;
          throw new Error(typeof data.message === "string" ? data.message : "Streaming request failed.");
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (!terminalEvent) throw new Error("The stream ended before the model completed its response.");
}

