import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamRequest } from "../../shared/contracts";
import { streamChat } from "./api";

const request: ChatStreamRequest = {
  provider: "gemini",
  model: "gemini-test",
  temperature: 0.2,
  maxOutputTokens: 32,
  messages: [{ role: "user", content: "Hello" }],
};

function eventStream(events: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  }), { status, statusText: status === 200 ? "OK" : "Bad Request", headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("chat stream debug callbacks", () => {
  it("reports HTTP, meta, deltas, and completion metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => eventStream([
      "event: meta\ndata: {\"provider\":\"gemini\",\"model\":\"gemini-test\",\"startedAt\":\"2026-08-14T00:00:00.000Z\"}\n\n",
      "event: delta\ndata: {\"text\":\"Hi\"}\n\n",
      "event: done\ndata: {\"finishReason\":\"STOP\",\"chunkCount\":1,\"textCharacters\":2}\n\n",
    ])));
    const seen: string[] = [];
    await streamChat(request, {
      onOpen(response) { seen.push(`open:${response.status}`); },
      onMeta(meta) { seen.push(`meta:${meta.model}`); },
      onDelta(text) { seen.push(`delta:${text}`); },
      onDone(done) { seen.push(`done:${done.finishReason}`); },
    }, new AbortController().signal);
    expect(seen).toEqual(["open:200", "meta:gemini-test", "delta:Hi", "done:STOP"]);
  });

  it("reports image events from the SSE stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => eventStream([
      "event: meta\ndata: {\"provider\":\"gemini\",\"model\":\"gemini-3.1-flash-image\",\"startedAt\":\"2026-08-14T00:00:00.000Z\"}\n\n",
      "event: image\ndata: {\"mimeType\":\"image/png\",\"data\":\"QUJDRA==\"}\n\n",
      "event: done\ndata: {\"finishReason\":\"STOP\"}\n\n",
    ])));
    const seen: string[] = [];
    await streamChat(request, {
      onDelta() {},
      onImage(image) { seen.push(`image:${image.mimeType}:${image.data}`); },
      onDone(done) { seen.push(`done:${done.finishReason}`); },
    }, new AbortController().signal);
    expect(seen).toEqual(["image:image/png:QUJDRA==", "done:STOP"]);
  });

  it("reports tool events from the SSE stream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => eventStream([
      "event: meta\ndata: {\"provider\":\"gemini\",\"model\":\"gemini-test\",\"startedAt\":\"2026-08-14T00:00:00.000Z\"}\n\n",
      "event: tool\ndata: {\"id\":\"image\",\"name\":\"generate_image\",\"args\":{\"prompt\":\"a monkey\"},\"model\":\"gemini-3.1-flash-image\"}\n\n",
      "event: done\ndata: {\"finishReason\":\"STOP\"}\n\n",
    ])));
    const seen: string[] = [];
    await streamChat(request, {
      onDelta() {},
      onTool(tool) { seen.push(`tool:${tool.id}:${tool.model}`); },
      onDone(done) { seen.push(`done:${done.finishReason}`); },
    }, new AbortController().signal);
    expect(seen).toEqual(["tool:image:gemini-3.1-flash-image", "done:STOP"]);
  });

  it("preserves normalized SSE error status for the debug trace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => eventStream([
      "event: error\ndata: {\"message\":\"model unavailable\",\"status\":404,\"durationMs\":22}\n\n",
    ])));
    const onError = vi.fn();
    await expect(streamChat(request, { onDelta() {}, onError }, new AbortController().signal))
      .rejects.toThrow("model unavailable");
    expect(onError).toHaveBeenCalledWith({ message: "model unavailable", status: 404, durationMs: 22 });
  });
});

