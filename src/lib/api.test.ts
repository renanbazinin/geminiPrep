import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamRequest, LargeFilesEvent } from "../../shared/contracts";
import { streamChat, uploadDocument, type UploadProgress } from "./api";

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
  it("decodes Unicode and CRLF split across individual bytes, including an unterminated final frame", async () => {
    const bytes = new TextEncoder().encode('event: delta\r\ndata: {"text":"שלום 🌷"}\r\n\r\nevent: done\r\ndata: {"finishReason":"STOP"}');
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    }))));
    const onDelta = vi.fn();
    const onDone = vi.fn();
    await streamChat(request, { onDelta, onDone }, new AbortController().signal);
    expect(onDelta).toHaveBeenCalledWith("שלום 🌷");
    expect(onDone).toHaveBeenCalledExactlyOnceWith({ finishReason: "STOP" });
  });

  it("stops reading at completion and cancels the reader without processing trailing garbage", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: done\ndata: {}\n\nevent: error\ndata: not-json\n\n')); },
      cancel,
    }))));
    const onDone = vi.fn();
    await streamChat(request, { onDelta() {}, onDone }, new AbortController().signal);
    expect(onDone).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects truncated streams and does not manufacture completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => eventStream(['event: delta\ndata: {"text":"Partial"}\n\n'])));
    const onDone = vi.fn();
    await expect(streamChat(request, { onDelta() {}, onDone }, new AbortController().signal)).rejects.toThrow("before the model completed");
    expect(onDone).not.toHaveBeenCalled();
  });
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


describe("large-file events in the chat stream", () => {
  it("hands largeFiles events to onLargeFiles beside activity and step, and ignores unknown events", async () => {
    const start = { type: "tool.start", callId: "call_1", tool: "search_document", args: { query: "ERROR" }, label: "Search app.log (exact) for “ERROR”", documentId: "doc_1", round: 1, seq: 4, runId: "run_1", time: 1 };
    const end = { type: "tool.end", callId: "call_1", outcome: "ok", ms: 4, step: "Search app.log (exact) for “ERROR” — 51 matching lines", evidence: { tool: "search_document", documentId: "doc_1", lines: [[97, 97]], callId: "call_1" }, seq: 5, runId: "run_1", time: 2 };
    vi.stubGlobal("fetch", vi.fn(async () => eventStream([
      "event: activity\ndata: {\"text\":\"Search app.log (exact) for “ERROR”…\"}\n\n",
      `event: largeFiles\ndata: ${JSON.stringify(start)}\n\n`,
      "event: somethingNew\ndata: {\"type\":\"tool.start\"}\n\n",
      `event: largeFiles\ndata: ${JSON.stringify(end)}\n\n`,
      "event: largeFiles\ndata: {\"no\":\"type\"}\n\n",
      ": keep-alive\n\n",
      "event: step\ndata: {\"text\":\"Search app.log (exact) for “ERROR” — 51 matching lines\"}\n\n",
      "event: done\ndata: {\"finishReason\":\"STOP\"}\n\n",
    ])));
    const seen: string[] = [];
    const events: LargeFilesEvent[] = [];
    await streamChat(request, {
      onDelta() {},
      onActivity(text) { seen.push(`activity:${text}`); },
      onStep(text) { seen.push(`step:${text}`); },
      onLargeFiles(event) { events.push(event); seen.push(`largeFiles:${event.type}`); },
      onDone() { seen.push("done"); },
    }, new AbortController().signal);
    expect(seen).toEqual([
      "activity:Search app.log (exact) for “ERROR”…",
      "largeFiles:tool.start",
      "largeFiles:tool.end",
      "step:Search app.log (exact) for “ERROR” — 51 matching lines",
      "done",
    ]);
    expect(events).toEqual([start, end]);
  });

  it("still works for a client that does not listen to largeFiles events", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => eventStream([
      "event: largeFiles\ndata: {\"type\":\"run.start\",\"models\":{\"answer\":\"m\"},\"documentIds\":[]}\n\n",
      "event: delta\ndata: {\"text\":\"Hi\"}\n\n",
      "event: done\ndata: {}\n\n",
    ])));
    const onDelta = vi.fn();
    await streamChat(request, { onDelta }, new AbortController().signal);
    expect(onDelta).toHaveBeenCalledExactlyOnceWith("Hi");
  });
});

const summary = {
  id: `doc_${"a".repeat(32)}`, name: "notes.csv", mimeType: "text/csv", format: "csv", bytes: 5_000, lines: 120,
  estimatedTokens: 900_000, expiresAt: "2026-12-01T00:00:00.000Z", encoding: "windows-1255", replacedCharacters: 2,
};

/** An upload answered with ingest events, sent in the pieces given. */
function ingestStream(pieces: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function sse(event: Record<string, unknown>, seq: number): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, seq, runId: "ing_1", time: seq })}\n\n`;
}

describe("document upload", () => {
  it("asks for progress, reports each stage and returns the document of ingest.finish", async () => {
    const finish = sse({ type: "ingest.finish", document: { ...summary, name: "notes\u2028 2026.csv" } }, 5);
    const fetchMock = vi.fn(async () => ingestStream([
      sse({ type: "ingest.start", name: "notes.csv", format: "csv", bytes: 5_000 }, 1),
      ": keep-alive\n\n",
      sse({ type: "ingest.progress", stage: "decode", done: 5_000, total: 5_000, unit: "bytes" }, 2).replace(/\n/g, "\r\n"),
      sse({ type: "ingest.progress", stage: "prepare", done: 10, unit: "characters" }, 3),
      "event: ingest.progress\ndata: not json\n\n",
      // The finish arrives split in the middle, with a raw U+2028 in the name.
      finish.slice(0, 40), finish.slice(40).replace("\\u2028", "\u2028"),
    ]));
    vi.stubGlobal("fetch", fetchMock);
    const progress: UploadProgress[] = [];
    const file = new Blob(["a,b\n"]);
    const document = await uploadDocument(file, "notes.csv", "text/csv", { onProgress: (event) => progress.push(event) });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/documents");
    expect(init.headers).toMatchObject({ Accept: "text/event-stream", "X-File-Name": "notes.csv", "X-File-Type": "text/csv" });
    expect(progress).toEqual([
      { stage: "decode", done: 5_000, total: 5_000, unit: "bytes" },
      { stage: "prepare", done: 10, unit: "characters" },
    ]);
    expect(document).toMatchObject({ ...summary, name: "notes\u2028 2026.csv" });
  });

  it("throws the message of ingest.error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ingestStream([
      sse({ type: "ingest.start", name: "empty.txt", format: "text", bytes: 0 }, 1),
      sse({ type: "ingest.error", error: { message: "empty.txt is empty.", status: 422 } }, 2),
    ])));
    await expect(uploadDocument(new Blob([]), "empty.txt", "text/plain")).rejects.toThrow("empty.txt is empty.");
  });

  it("does not take a stream that ends without an answer for a stored document", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ingestStream([sse({ type: "ingest.progress", stage: "extract", done: 1, total: 4, unit: "pages" }, 1)])));
    await expect(uploadDocument(new Blob(["x"]), "report.pdf", "application/pdf")).rejects.toThrow("ended before the server said whether it was stored");
  });

  it("keeps a CRLF split between two chunks as one line break", async () => {
    // Two data lines of one message (joined by "\n" they make the JSON), the CRLF between them split after the CR.
    vi.stubGlobal("fetch", vi.fn(async () => ingestStream([
      `event: ingest.finish\r\ndata: {"type":"ingest.finish","seq":1,"runId":"ing_1","time":1,\r`,
      `\ndata: "document":${JSON.stringify(summary)}}\r\n\r`,
      "\n",
    ])));
    await expect(uploadDocument(new Blob(["x"]), "notes.csv", "text/csv")).resolves.toEqual(summary);
  });

  it("reads a JSON 201 as before (original engine) and calls no progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(summary), { status: 201, headers: { "Content-Type": "application/json" } })));
    const onProgress = vi.fn();
    await expect(uploadDocument(new Blob(["x"]), "notes.csv", "text/csv", { onProgress })).resolves.toEqual(summary);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("reads every HTTP error as JSON, as before", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "huge.log is larger than 100 MB." }), { status: 413, headers: { "Content-Type": "application/json" } })));
    await expect(uploadDocument(new Blob(["x"]), "huge.log", "")).rejects.toThrow("huge.log is larger than 100 MB.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    await expect(uploadDocument(new Blob(["x"]), "huge.log", "")).rejects.toThrow("Request failed (502).");
  });
});
