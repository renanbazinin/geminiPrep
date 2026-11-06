// @ts-nocheck -- Fetch stream doubles intentionally implement only the behavior under test.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resolveGeminiChatModels, resolveProbeRegions, resolveVertexChatModels } from "../catalog.js";
import { validateChatRequest } from "../chat/validation.js";
import { baseRequestSize, materializeDocuments } from "../chat/document-stream.js";
import { createLargeFiles, MemoryDocumentStore } from "../../packages/large-files/src/index.js";
import { DEFAULT_INTERACTIONS } from "../../shared/interactions.js";

function log(lines: number): string {
  return Array.from({ length: lines }, (_, index) => (index + 1) % 250 === 0
    ? `2026-05-01 12:00:00 ERROR db: deadlock detected on table orders (tx ${index + 1})`
    : `2026-05-01 12:00:00 INFO request ${index + 1} ok`).join("\n");
}

function sse(chunks: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function events(text: string) {
  return text.split("\n\n").filter(Boolean).map((block) => ({
    event: /^event: (.+)$/m.exec(block)?.[1],
    data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null"),
  }));
}

function chatBody(documentId: string, extra = {}) {
  return {
    provider: "gemini",
    model: resolveGeminiChatModels()[0].id,
    temperature: 1,
    maxOutputTokens: 1024,
    messages: [{
      role: "user",
      content: "How many deadlocks happened?",
      files: [{ kind: "document", name: "app.log", mimeType: "text/plain", documentId }],
    }],
    ...extra,
  };
}

describe("large file uploads", () => {
  it("stores a raw upload, including JSON, and returns its summary", async () => {
    const largeFiles = createLargeFiles({ store: new MemoryDocumentStore() });
    const app = createApp({ largeFiles });
    const upload = await request(app)
      .post("/api/documents")
      .set("Content-Type", "application/json")
      .set("X-File-Name", encodeURIComponent("נתונים.json"))
      .set("X-File-Type", "application/json")
      // A string body: supertest would JSON-encode a Buffer sent as application/json.
      .send('{"a": 1}\n{"a": 2}');
    expect(upload.status).toBe(201);
    expect(upload.body).toMatchObject({ name: "נתונים.json", format: "json", lines: 2, bytes: 17 });
    expect((await request(app).get(`/api/documents/${upload.body.id}`)).body.name).toBe("נתונים.json");
    expect((await request(app).delete(`/api/documents/${upload.body.id}`)).body).toEqual({ deleted: true });
    expect((await request(app).get(`/api/documents/${upload.body.id}`)).status).toBe(404);
  });

  it("returns JSON errors for missing names, unreadable files, and oversized uploads", async () => {
    const app = createApp({ largeFiles: createLargeFiles({ store: new MemoryDocumentStore(), maxUploadBytes: 1024 }) });
    expect((await request(app).post("/api/documents").send("x")).body.error).toMatch(/X-File-Name/);
    const binary = await request(app).post("/api/documents").set("Content-Type", "application/octet-stream").set("X-File-Name", "a.bin").send(Buffer.alloc(500, 0));
    expect(binary.status).toBe(422);
    const big = await request(app).post("/api/documents").set("Content-Type", "application/octet-stream").set("X-File-Name", "a.txt").send(Buffer.alloc(5_000, 65));
    expect(big.status).toBe(413);
    expect(big.body.error).toMatch(/upload limit/);
  });

  it("validates document references in chat requests", () => {
    const catalogs = { vertexModels: resolveVertexChatModels(), geminiModels: resolveGeminiChatModels(), regions: resolveProbeRegions() };
    expect(() => validateChatRequest(chatBody("doc_../../etc"), catalogs)).toThrow(/documentId is invalid/);
    const valid = validateChatRequest(chatBody(`doc_${"a".repeat(32)}`), catalogs);
    expect(valid.messages[0].files[0]).toEqual({ kind: "document", name: "app.log", mimeType: "text/plain", documentId: `doc_${"a".repeat(32)}` });
  });

  it("replaces references with planned text once per document and sizes the rest", () => {
    const id = `doc_${"b".repeat(32)}`;
    const request = {
      ...chatBody(id),
      messages: [
        { role: "user", content: "first", files: [{ kind: "document", name: "a.md", mimeType: "text/markdown", documentId: id }, { kind: "text", name: "n.txt", mimeType: "text/plain", text: "note" }] },
        { role: "assistant", content: "ok" },
        { role: "user", content: "again", files: [{ kind: "document", name: "a.md", mimeType: "text/markdown", documentId: id }] },
      ],
    };
    const result = materializeDocuments(request, new Map([[id, "FULL TEXT"]]));
    expect(result.messages[0]).toEqual({ role: "user", content: "first\n\nFULL TEXT", files: [{ kind: "text", name: "n.txt", mimeType: "text/plain", text: "note" }] });
    expect(result.messages[2]).toEqual({ role: "user", content: "again\n\n(The file a.md is attached earlier in this conversation.)" });
    expect(baseRequestSize(request).tokens).toBeGreaterThan(2_000);
  });
});

describe("chat with large files", () => {
  const previousKey = process.env.GEMINI_API_KEY;
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  });

  it("puts a file that fits into the prompt and keeps the selected Interactions API", async () => {
    const largeFiles = createLargeFiles({ store: new MemoryDocumentStore() });
    const meta = await largeFiles.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(500)) });
    const fetchImpl = vi.fn(async () => sse([
      { event_type: "interaction.start", interaction: { id: "int_1" } },
      { event_type: "step.start", index: 0, step: { type: "model_output", content: [{ type: "text", text: "Two." }] } },
      { event_type: "interaction.completed", interaction: { id: "int_1", status: "completed" } },
    ]));
    const response = await request(createApp({ fetchImpl, largeFiles }))
      .post("/api/chat/stream")
      .send(chatBody(meta.id, { interactions: { ...DEFAULT_INTERACTIONS, stateful: false } }));
    expect(response.status).toBe(200);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/\/interactions$/);
    const sent = JSON.parse(init.body);
    expect(sent.input[0].content[0].text).toContain("--- Attached file: app.log (log, 500 lines) ---");
    expect(sent.input[0].content[0].text).toContain("deadlock detected on table orders (tx 250)");
    expect(sent.tools).toBeUndefined();
  });

  it("gives the model search tools for a file that does not fit, and streams the answer", async () => {
    const largeFiles = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await largeFiles.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(5_000)) });
    const bodies = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return sse([{ candidates: [{ content: { role: "model", parts: [
          { text: "Let me check." },
          { functionCall: { name: "search_document", args: { document_id: meta.id, query: "deadlock", mode: "exact" } }, thoughtSignature: "sig-1" },
        ] } }] }]);
      }
      return sse([
        { candidates: [{ content: { role: "model", parts: [{ text: "There were 20 deadlocks (app.log L250)." }] } }] },
        { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 99 } },
      ]);
    });
    const response = await request(createApp({ fetchImpl, largeFiles }))
      .post("/api/chat/stream")
      .send(chatBody(meta.id, { interactions: { ...DEFAULT_INTERACTIONS, stateful: false } }));

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/:streamGenerateContent\?alt=sse$/);
    const first = bodies[0];
    expect(first.tools[0].functionDeclarations.map((tool) => tool.name)).toEqual(["search_document", "read_document", "get_document_overview", "analyze_whole_document"]);
    expect(first.systemInstruction.parts[0].text).toContain(`app.log (document_id ${meta.id})`);
    expect(first.contents[0].parts[0].text).toContain("--- Large attached file: app.log ---");
    expect(first.contents[0].parts[0].text).not.toContain("request 4000 ok");
    // The model's turn goes back unchanged, thought signature included, followed by the result.
    const second = bodies[1];
    expect(second.contents.at(-2)).toEqual({ role: "model", parts: [
      { text: "Let me check." },
      { functionCall: { name: "search_document", args: { document_id: meta.id, query: "deadlock", mode: "exact" } }, thoughtSignature: "sig-1" },
    ] });
    expect(second.contents.at(-1).parts[0].functionResponse).toMatchObject({ name: "search_document", response: { total_matching_lines: 20 } });

    const streamed = events(response.text);
    expect(streamed.filter((event) => event.event === "step").map((event) => event.data.text)).toEqual(["Search app.log (exact) for “deadlock” — 20 matching lines"]);
    expect(streamed.filter((event) => event.event === "delta").map((event) => event.data.text).join("")).toBe("Let me check.\n\nThere were 20 deadlocks (app.log L250).");
    expect(streamed.at(-1)).toMatchObject({ event: "done", data: { finishReason: "STOP", usage: { totalTokenCount: 99 } } });
  });

  it("asks for an answer with no tools declared once the tool turns run out", async () => {
    vi.stubEnv("LARGE_FILES_MAX_TOOL_TURNS", "4");
    const largeFiles = createLargeFiles({ store: new MemoryDocumentStore(), budget: { inlineTokens: 1_000 } });
    const meta = await largeFiles.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(5_000)) });
    const bodies = [];
    // Like Gemini 3 in practice: it keeps calling tools as long as any are declared.
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (!body.tools) return sse([{ candidates: [{ content: { parts: [{ text: "Best answer so far." }] }, finishReason: "STOP" }] }]);
      return sse([{ candidates: [{ content: { parts: [{ functionCall: { name: "read_document", args: { document_id: meta.id, start_line: bodies.length * 10 } } }] } }] }]);
    });
    const response = await request(createApp({ fetchImpl, largeFiles })).post("/api/chat/stream").send(chatBody(meta.id));
    vi.unstubAllEnvs();
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const streamed = events(response.text);
    expect(streamed.filter((event) => event.event === "step")).toHaveLength(3);
    expect(bodies[1].contents.at(-1).parts[0].functionResponse.response.tool_turns_left).toBe(2);
    const final = bodies.at(-1);
    expect(final.toolConfig).toBeUndefined();
    expect(final.contents.at(-1)).toEqual({ role: "user", parts: [{ text: expect.stringMatching(/^Stop using tools now/) }] });
    expect(streamed.filter((event) => event.event === "delta").map((event) => event.data.text).join("")).toBe("Best answer so far.");
    expect(streamed.at(-1).event).toBe("done");
  });

  it("asks for a fresh upload when a file has expired", async () => {
    const app = createApp({ fetchImpl: vi.fn(), largeFiles: createLargeFiles({ store: new MemoryDocumentStore() }) });
    const response = await request(app).post("/api/chat/stream").send(chatBody(`doc_${"c".repeat(32)}`));
    expect(response.status).toBe(410);
    expect(response.body.error).toBe("app.log is no longer on the server. Start a new chat and attach the file again.");
  });
});
