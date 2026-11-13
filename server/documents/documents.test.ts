// @ts-nocheck -- Fetch stream doubles intentionally implement only the behavior under test.
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resolveGeminiChatModels, resolveProbeRegions, resolveVertexChatModels } from "../catalog.js";
import { validateChatRequest } from "../chat/validation.js";
import { createLargeFiles as createPackageLargeFiles, MemoryDocumentStore as PackageMemoryStore } from "llm-large-files";
import { baseRequestSize, materializeDocuments } from "../chat/document-stream.js";
import { createLargeFiles as createOriginalLargeFiles, MemoryDocumentStore as OriginalMemoryStore } from "../../packages/large-files/src/index.js";
import { GEMINI_4_MIN_OUTPUT_TOKENS } from "../../shared/gemini-4.js";
import { DEFAULT_INTERACTIONS } from "../../shared/interactions.js";
import { createServerLargeFiles, removeOrphanOriginals, resolveLargeFilesEngine, resolvePagePlacement } from "./config.js";

/** Every upload and chat test runs on both engines (LARGE_FILES_ENGINE=npm and =original). */
const ENGINES = [
  { engine: "npm", create: (options = {}) => ({ engine: "npm", files: createPackageLargeFiles({ store: new PackageMemoryStore(), ...options }) }) },
  { engine: "original", create: (options = {}) => ({ engine: "original", files: createOriginalLargeFiles({ store: new OriginalMemoryStore(), ...options }) }) },
] as const;

/** All text the model sees in one turn. */
function turnText(content) {
  return content.parts.map((part) => part.text ?? "").join("\n");
}

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

describe("large files engine flag", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the npm package by default and the original code on request", () => {
    vi.stubEnv("LARGE_FILES_ENGINE", "");
    expect(resolveLargeFilesEngine()).toBe("npm");
    vi.stubEnv("LARGE_FILES_ENGINE", " Original ");
    expect(resolveLargeFilesEngine()).toBe("original");
    expect(createServerLargeFiles("original").engine).toBe("original");
    expect(createServerLargeFiles("npm").engine).toBe("npm");
  });

  it("refuses an unknown engine instead of silently picking one", () => {
    vi.stubEnv("LARGE_FILES_ENGINE", "v2");
    expect(() => resolveLargeFilesEngine()).toThrow('LARGE_FILES_ENGINE must be "npm" or "original", not "v2".');
  });
});

describe.each(ENGINES)("large file uploads ($engine engine)", ({ create }) => {
  it("stores a raw upload, including JSON, and returns its summary", async () => {
    const app = createApp({ largeFiles: create() });
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
    const app = createApp({ largeFiles: create({ maxUploadBytes: 1024 }) });
    const unnamed = await request(app).post("/api/documents").send("x");
    expect(unnamed.status).toBe(400);
    expect(unnamed.body.error).toMatch(/X-File-Name/);
    const binary = await request(app).post("/api/documents").set("Content-Type", "application/octet-stream").set("X-File-Name", "a.bin").send(Buffer.alloc(500, 0));
    expect(binary.status).toBe(422);
    const big = await request(app).post("/api/documents").set("Content-Type", "application/octet-stream").set("X-File-Name", "a.txt").send(Buffer.alloc(5_000, 65));
    expect(big.status).toBe(413);
    expect(big.body.error).toMatch(/upload limit/);
  });
});

describe("document references", () => {
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

describe.each(ENGINES)("chat with large files ($engine engine)", ({ engine, create }) => {
  const previousKey = process.env.GEMINI_API_KEY;
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterEach(() => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  });

  it("puts a file that fits into the prompt and keeps the selected Interactions API", async () => {
    const largeFiles = create();
    const meta = await largeFiles.files.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(500)) });
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
    const largeFiles = create({ budget: { inlineTokens: 1_000 } });
    const meta = await largeFiles.files.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(5_000)) });
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
    // The package puts file names in quotes, so a name cannot pass for part of the instruction.
    expect(first.systemInstruction.parts[0].text).toContain(engine === "npm" ? `"app.log" (document_id ${meta.id})` : `app.log (document_id ${meta.id})`);
    expect(turnText(first.contents[0])).toContain("How many deadlocks happened?");
    expect(turnText(first.contents[0])).toContain("--- Large attached file: app.log ---");
    expect(turnText(first.contents[0])).not.toContain("request 4000 ok");
    expect(JSON.stringify(first)).not.toContain("[Large file app.log is stored on the server");
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
    const largeFiles = create({ budget: { inlineTokens: 1_000 } });
    const meta = await largeFiles.files.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(5_000)) });
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
    // Three rounds of tool calls on both engines. The original engine then lets the model call
    // tools once more, drops those calls and asks again; the package makes its fourth request the tool-free one.
    expect(fetchImpl).toHaveBeenCalledTimes(engine === "npm" ? 4 : 5);
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
    const app = createApp({ fetchImpl: vi.fn(), largeFiles: create() });
    const response = await request(app).post("/api/chat/stream").send(chatBody(`doc_${"c".repeat(32)}`));
    expect(response.status).toBe(410);
    expect(response.body.error).toBe("app.log is no longer on the server. Start a new chat and attach the file again.");
  });

  it("reports a Gemini HTTP error as a stream error", async () => {
    const largeFiles = create({ budget: { inlineTokens: 1_000 } });
    const meta = await largeFiles.files.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(5_000)) });
    const fetchImpl = vi.fn(async () => Response.json({ error: { message: "Resource exhausted." } }, { status: 429 }));
    const response = await request(createApp({ fetchImpl, largeFiles })).post("/api/chat/stream").send(chatBody(meta.id));
    const streamed = events(response.text);
    expect(streamed.at(-1)).toMatchObject({ event: "error", data: { message: "Resource exhausted.", status: 429 } });
  });

  it("keeps a file attached earlier in the conversation, and a message that is only a file", async () => {
    const largeFiles = create({ budget: { inlineTokens: 1_000 } });
    const meta = await largeFiles.files.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(5_000)) });
    const document = { kind: "document", name: "app.log", mimeType: "text/plain", documentId: meta.id };
    const bodies = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sse([{ candidates: [{ content: { parts: [{ text: "Twenty." }] }, finishReason: "STOP" }] }]);
    });
    const app = createApp({ fetchImpl, largeFiles });

    await request(app).post("/api/chat/stream").send(chatBody(meta.id, { messages: [
      { role: "user", content: "Here is the log.", files: [document] },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "How many deadlocks happened?" },
    ] }));
    const followUp = bodies[0].contents;
    expect(followUp).toHaveLength(3);
    // Every engine sends the card exactly once, and the model still knows where the file was attached.
    expect(followUp.map(turnText).join("\n").match(/--- Large attached file: app\.log ---/g)).toHaveLength(1);
    expect(turnText(followUp[0])).toContain("app.log");
    expect(turnText(followUp[2])).toContain("How many deadlocks happened?");

    await request(app).post("/api/chat/stream").send(chatBody(meta.id, { messages: [{ role: "user", content: "", files: [document] }] }));
    const onlyFile = bodies[1].contents[0];
    expect(onlyFile.parts.every((part) => typeof part.text !== "string" || part.text.trim())).toBe(true);
    expect(turnText(onlyFile)).toContain("--- Large attached file: app.log ---");
    // The package keeps the card at the start of the first user message, so it needs no note there.
    if (engine === "npm") {
      expect(turnText(followUp[0])).toMatch(/^--- Large attached file: app\.log ---[^]*Here is the log\.$/);
      expect(JSON.stringify(bodies)).not.toContain("(Attached file:");
    }
  });
});

/** A real PDF with one line of text on each page. */
async function pdf(pages: string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of pages) document.addPage([595, 842]).drawText(text, { x: 50, y: 780, size: 12, font });
  return document.save();
}

const REPORT = ["Sales report 2026", "Figure 1: sales by region (chart)", "Figure 2: the sign at the gate (photo)", "Closing notes"];

function reportBody(documentId: string, extra = {}) {
  return chatBody(documentId, {
    messages: [{
      role: "user",
      content: "Which region has the tallest bar in Figure 1?",
      files: [{ kind: "document", name: "report.pdf", mimeType: "application/pdf", documentId }],
    }],
    ...extra,
  });
}

describe("an explorer model (npm engine)", () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const MODELS = "https://generativelanguage.googleapis.com/v1beta/models";
  const picked = resolveGeminiChatModels()[0].id;
  const ANSWER = "There were 20 deadlocks (app.log L250).";
  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  });

  async function largeLog(budget = {}) {
    const largeFiles = ENGINES[0].create({ budget: { inlineTokens: 1_000, ...budget } });
    const meta = await largeFiles.files.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(5_000)) });
    return { largeFiles, meta };
  }

  const partRead = (body) => body.systemInstruction?.role === "system";
  const explored = (body) => body.contents.some((content) => content.parts.some((part) => part.functionResponse));

  /**
   * Gemini as the app reaches it. Asked with tools, a model makes `call` once and then says
   * `closing`. Asked without tools, it answers. A part of a whole-file read gets notes. A
   * streaming URL is answered with a stream.
   */
  function gemini(calls, closing: string, call) {
    return vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      const parts = partRead(body) ? [{ text: "Deadlocks on table orders (L250)." }]
        : !body.tools ? [{ text: ANSWER }]
          : explored(body) ? [{ text: closing }]
            : [{ text: "Let me check." }, { functionCall: call, thoughtSignature: "sig-1" }];
      const reply = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] };
      return String(url).includes(":streamGenerateContent") ? sse([reply]) : Response.json(reply);
    });
  }
  const search = (documentId: string) => ({ name: "search_document", args: { document_id: documentId, query: "deadlock", mode: "exact" } });
  const deltas = (streamed) => streamed.filter((event) => event.event === "delta").map((event) => event.data.text).join("");

  it("sends the searching to LARGE_FILES_EXPLORER_MODEL and the answer to the model picked in the chat", async () => {
    vi.stubEnv("LARGE_FILES_EXPLORER_MODEL", " gemini-explorer-test ");
    const { largeFiles, meta } = await largeLog();
    const calls = [];
    const response = await request(createApp({ fetchImpl: gemini(calls, "DONE", search(meta.id)), largeFiles }))
      .post("/api/chat/stream").send(chatBody(meta.id, { thinkingLevel: "high" }));
    expect(response.status).toBe(200);
    // Two requests to the explorer, each in one piece, and the answer streamed from the picked model.
    expect(calls.map((call) => call.url)).toEqual([
      `${MODELS}/gemini-explorer-test:generateContent`,
      `${MODELS}/gemini-explorer-test:generateContent`,
      `${MODELS}/${picked}:streamGenerateContent?alt=sse`,
    ]);
    const [first, , answer] = calls.map((call) => call.body);
    expect(first.tools[0].functionDeclarations.map((tool) => tool.name)).toEqual(["search_document", "read_document", "get_document_overview", "analyze_whole_document"]);
    expect(first.systemInstruction.parts[0].text).toMatch(/reply with the single word DONE instead of an answer\.$/);
    // The explorer runs with the settings of the chat.
    expect(first.generationConfig).toEqual({ temperature: 1, maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "high" } });
    expect(answer.generationConfig).toEqual(first.generationConfig);

    // The picked model gets no tools. Of the explorer it gets the call and its result, and nothing else.
    expect(answer.tools).toBeUndefined();
    expect(answer.systemInstruction.parts[0].text).not.toMatch(/single word DONE/);
    expect(answer.contents.at(-3)).toEqual({ role: "model", parts: [{ functionCall: search(meta.id) }] });
    expect(answer.contents.at(-2).parts[0].functionResponse).toMatchObject({ name: "search_document", response: { total_matching_lines: 20 } });
    expect(answer.contents.at(-1)).toEqual({ role: "user", parts: [{ text: expect.stringMatching(/^Stop using tools now/) }] });
    expect(JSON.stringify(answer)).not.toContain("sig-1");
    expect(JSON.stringify(answer)).not.toContain("Let me check.");

    const streamed = events(response.text);
    expect(streamed.find((event) => event.event === "meta").data.model).toBe(picked);
    expect(streamed.filter((event) => event.event === "step").map((event) => event.data.text)).toEqual(["Search app.log (exact) for “deadlock” — 20 matching lines"]);
    // Only the picked model's words reach the chat: not the explorer's remark, and not its DONE.
    expect(deltas(streamed)).toBe(ANSWER);
    expect(streamed.at(-1)).toMatchObject({ event: "done", data: { finishReason: "STOP" } });
  });

  it.each([["empty", "  "], ["the picked model itself", picked]])("leaves both halves to the picked model when the setting is %s", async (_label, value) => {
    vi.stubEnv("LARGE_FILES_EXPLORER_MODEL", value);
    const { largeFiles, meta } = await largeLog();
    const calls = [];
    const response = await request(createApp({ fetchImpl: gemini(calls, ANSWER, search(meta.id)), largeFiles }))
      .post("/api/chat/stream").send(chatBody(meta.id));
    const stream = `${MODELS}/${picked}:streamGenerateContent?alt=sse`;
    expect(calls.map((call) => call.url)).toEqual([stream, stream]);
    expect(calls[0].body.systemInstruction.parts[0].text).not.toMatch(/single word DONE/);
    // Its own turn goes back to it unchanged, and its remark is part of what it said.
    expect(calls[1].body.contents.at(-2).parts[1]).toEqual({ functionCall: search(meta.id), thoughtSignature: "sig-1" });
    expect(deltas(events(response.text))).toBe(`Let me check.\n\n${ANSWER}`);
  });

  it("works out the explorer's settings for the explorer's model", async () => {
    const { largeFiles, meta } = await largeLog();
    const settingsWith = async (explorerModel: string) => {
      vi.stubEnv("LARGE_FILES_EXPLORER_MODEL", explorerModel);
      const calls = [];
      await request(createApp({ fetchImpl: gemini(calls, "DONE", search(meta.id)), largeFiles }))
        .post("/api/chat/stream").send(chatBody(meta.id, { thinkingLevel: "high" }));
      expect(calls[0].url).toBe(`${MODELS}/${explorerModel}:generateContent`);
      return { explorer: calls[0].body.generationConfig, answer: calls.at(-1).body.generationConfig };
    };
    // Gemini 2.5 refuses a thinking level, so it gets none. The picked model keeps its own.
    const older = await settingsWith("gemini-2.5-flash-lite");
    expect(older.explorer).toEqual({ temperature: 1, maxOutputTokens: 1024 });
    expect(older.answer).toEqual({ temperature: 1, maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "high" } });
    // Gemini 4 takes no temperature and shares its output budget with thinking.
    const newer = await settingsWith("gemini-4-argon");
    expect(newer.explorer).toEqual({ maxOutputTokens: GEMINI_4_MIN_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: "high" } });
    expect(newer.answer).toEqual(older.answer);
  });

  it("has the explorer read a whole file in parts, with settings for its model", async () => {
    const { largeFiles, meta } = await largeLog({ mapChunkTokens: 40_000 });
    const readWith = async (explorerModel: string) => {
      vi.stubEnv("LARGE_FILES_EXPLORER_MODEL", explorerModel);
      const calls = [];
      const whole = { name: "analyze_whole_document", args: { document_id: meta.id, task: "List every kind of error." } };
      const response = await request(createApp({ fetchImpl: gemini(calls, "DONE", whole), largeFiles }))
        .post("/api/chat/stream").send(chatBody(meta.id, { thinkingLevel: "high" }));
      const parts = calls.filter((call) => partRead(call.body));
      expect(parts.length).toBeGreaterThan(2);
      // Every part goes to the explorer. The picked model is called once, for the answer.
      expect(parts.every((call) => call.url === `${MODELS}/${explorerModel}:generateContent`)).toBe(true);
      expect(calls.filter((call) => call.url.includes(`/${picked}:`))).toHaveLength(1);
      expect(deltas(events(response.text))).toBe(ANSWER);
      return parts[0].body.generationConfig;
    };
    expect(await readWith("gemini-explorer-test")).toEqual({ temperature: 0.2, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "low" } });
    expect(await readWith("gemini-2.5-flash-lite")).toEqual({ temperature: 0.2, maxOutputTokens: 4096 });
    expect(await readWith("gemini-4-argon")).toEqual({ maxOutputTokens: GEMINI_4_MIN_OUTPUT_TOKENS, thinkingConfig: { thinkingLevel: "low" } });
  });

  it("reports an explorer model that does not exist as a stream error", async () => {
    vi.stubEnv("LARGE_FILES_EXPLORER_MODEL", "gemini-no-such-model");
    const { largeFiles, meta } = await largeLog();
    const fetchImpl = vi.fn(async () => Response.json({ error: { message: "models/gemini-no-such-model is not found." } }, { status: 404 }));
    const response = await request(createApp({ fetchImpl, largeFiles })).post("/api/chat/stream").send(chatBody(meta.id));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events(response.text).at(-1)).toMatchObject({ event: "error", data: { message: "models/gemini-no-such-model is not found.", status: 404 } });
  });

  it("does not use the explorer with the original engine", async () => {
    vi.stubEnv("LARGE_FILES_EXPLORER_MODEL", "gemini-explorer-test");
    const largeFiles = ENGINES[1].create({ budget: { inlineTokens: 1_000 } });
    const meta = await largeFiles.files.ingest({ name: "app.log", bytes: new TextEncoder().encode(log(5_000)) });
    const calls = [];
    await request(createApp({ fetchImpl: gemini(calls, ANSWER, search(meta.id)), largeFiles })).post("/api/chat/stream").send(chatBody(meta.id));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.url.includes(`/${picked}:`))).toBe(true);
  });
});

describe("pages of a kept PDF (npm engine)", () => {
  const previousKey = process.env.GEMINI_API_KEY;
  let directory: string;
  beforeEach(async () => {
    process.env.GEMINI_API_KEY = "test-key";
    directory = await mkdtemp(path.join(tmpdir(), "gemini-prep-large-files-"));
    vi.stubEnv("LARGE_FILES_DIR", directory);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  });

  async function upload(app, bytes: Uint8Array, name = "report.pdf") {
    const response = await request(app).post("/api/documents")
      .set("Content-Type", "application/octet-stream").set("X-File-Name", name).set("X-File-Type", "application/pdf")
      .send(Buffer.from(bytes));
    expect(response.status).toBe(201);
    return response.body;
  }

  /** Gemini asks to look at pages 2 and 3, then answers. */
  function lookThenAnswer(documentId: string, bodies: unknown[]) {
    return vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return sse([{ candidates: [{ content: { role: "model", parts: [
          { functionCall: { name: "view_pages", args: { document_id: documentId, from_page: 2, to_page: 3 } }, thoughtSignature: "sig-1" },
        ] } }] }]);
      }
      return sse([{ candidates: [{ content: { role: "model", parts: [{ text: "South (report.pdf page 2)." }] }, finishReason: "STOP" }] }]);
    });
  }

  it("keeps an uploaded PDF next to its text, and removes it with the document", async () => {
    const app = createApp({ largeFiles: createServerLargeFiles("npm") });
    const bytes = await pdf(REPORT);
    const first = await upload(app, bytes);
    expect(first).toMatchObject({ name: "report.pdf", format: "pdf", pages: 4 });
    expect(new Uint8Array(await readFile(path.join(directory, `${first.id}.bin`)))).toEqual(bytes);
    expect((await request(app).delete(`/api/documents/${first.id}`)).body).toEqual({ deleted: true });
    expect(await readdir(directory)).toEqual([]);

    // A text file has nothing to look at, so only its text is stored.
    const text = await request(app).post("/api/documents").set("Content-Type", "application/octet-stream").set("X-File-Name", "app.log").send(Buffer.from(log(50)));
    expect((await readdir(directory)).sort()).toEqual([`${text.body.id}.idx`, `${text.body.id}.json`, `${text.body.id}.txt`]);
  });

  it("removes a kept PDF when its document expires", async () => {
    // 3.6 milliseconds.
    vi.stubEnv("LARGE_FILES_TTL_HOURS", "0.000001");
    const largeFiles = createServerLargeFiles("npm");
    const meta = await upload(createApp({ largeFiles }), await pdf(REPORT));
    expect(await readdir(directory)).toContain(`${meta.id}.bin`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await largeFiles.files.sweep()).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not keep PDFs when LARGE_FILES_KEEP_PDFS is off", async () => {
    vi.stubEnv("LARGE_FILES_KEEP_PDFS", "0");
    const meta = await upload(createApp({ largeFiles: createServerLargeFiles("npm") }), await pdf(REPORT));
    expect((await readdir(directory)).sort()).toEqual([`${meta.id}.idx`, `${meta.id}.json`, `${meta.id}.txt`]);
  });

  it("lets Gemini look at pages of a PDF whose text fits, and shows the look as a step", async () => {
    const largeFiles = createServerLargeFiles("npm");
    const bodies = [];
    const fetchImpl = lookThenAnswer("", bodies);
    const app = createApp({ fetchImpl, largeFiles });
    const meta = await upload(app, await pdf(REPORT));
    fetchImpl.mockImplementation(lookThenAnswer(meta.id, bodies));
    const response = await request(app).post("/api/chat/stream").send(reportBody(meta.id));

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toMatch(/:streamGenerateContent\?alt=sse$/);
    const [first, second] = bodies;
    // The text is in the prompt, so the only tool is the one that shows pages.
    expect(first.tools[0].functionDeclarations.map((tool) => tool.name)).toEqual(["view_pages"]);
    expect(turnText(first.contents[0])).toContain("Figure 1: sales by region (chart)");
    expect(turnText(first.contents[0])).toContain("Which region has the tallest bar in Figure 1?");
    expect(first.systemInstruction.parts[0].text).toContain(`"report.pdf" (document_id ${meta.id}, 4 pages)`);
    // The pages come back as a PDF of their own, inside the function response.
    expect(second.contents.at(-2).parts[0]).toMatchObject({ functionCall: { name: "view_pages" }, thoughtSignature: "sig-1" });
    const answer = second.contents.at(-1);
    expect(answer.parts).toHaveLength(1);
    expect(answer.parts[0].functionResponse).toMatchObject({ name: "view_pages", response: { document: "report.pdf", pages: "2-3", total_pages: 4 } });
    const [file] = answer.parts[0].functionResponse.parts;
    expect(file.inlineData.mimeType).toBe("application/pdf");
    const shown = await PDFDocument.load(Buffer.from(file.inlineData.data, "base64"));
    expect(shown.getPageCount()).toBe(2);

    const streamed = events(response.text);
    expect(streamed.filter((event) => event.event === "step").map((event) => event.data.text)).toEqual(["Look at report.pdf pages 2-3"]);
    expect(streamed.filter((event) => event.event === "delta").map((event) => event.data.text).join("")).toBe("South (report.pdf page 2).");
    expect(streamed.at(-1)).toMatchObject({ event: "done", data: { finishReason: "STOP" } });
  });

  it("sends the pages in a turn of their own when LARGE_FILES_PAGE_PLACEMENT is beside", async () => {
    vi.stubEnv("LARGE_FILES_PAGE_PLACEMENT", "beside");
    const largeFiles = createServerLargeFiles("npm");
    const bodies = [];
    const fetchImpl = lookThenAnswer("", bodies);
    const app = createApp({ fetchImpl, largeFiles });
    const meta = await upload(app, await pdf(REPORT));
    fetchImpl.mockImplementation(lookThenAnswer(meta.id, bodies));
    await request(app).post("/api/chat/stream").send(reportBody(meta.id));

    // The function response alone in its turn (Vertex AI refuses anything after one), then the pages.
    const [answer, pages] = bodies[1].contents.slice(-2);
    expect(answer.parts).toHaveLength(1);
    expect(answer.parts[0].functionResponse).toMatchObject({ name: "view_pages", response: { pages: "2-3", file: "pages-2-3.pdf" } });
    expect(answer.parts[0].functionResponse.parts).toBeUndefined();
    expect(pages.role).toBe("user");
    expect(pages.parts[0]).toEqual({ text: "pages-2-3.pdf (returned by view_pages):" });
    expect(pages.parts.filter((part) => part.inlineData).map((part) => part.inlineData.mimeType)).toEqual(["application/pdf"]);
  });

  it("refuses an unknown page placement", () => {
    vi.stubEnv("LARGE_FILES_PAGE_PLACEMENT", "after");
    expect(() => resolvePagePlacement()).toThrow('LARGE_FILES_PAGE_PLACEMENT must be "inside" or "beside", not "after".');
  });

  it("answers from the text alone when the user picked a tool, or when page views are off", async () => {
    const largeFiles = createServerLargeFiles("npm");
    const bodies = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sse([{ candidates: [{ content: { parts: [{ text: "South." }] }, finishReason: "STOP" }] }]);
    });
    const app = createApp({ fetchImpl, largeFiles });
    const meta = await upload(app, await pdf(REPORT));

    await request(app).post("/api/chat/stream").send(reportBody(meta.id, { tool: "graph" }));
    expect(bodies[0].tools).toBeUndefined();
    expect(turnText(bodies[0].contents[0])).toContain("Figure 1: sales by region (chart)");

    vi.stubEnv("LARGE_FILES_KEEP_PDFS", "0");
    await request(app).post("/api/chat/stream").send(reportBody(meta.id));
    expect(JSON.stringify(bodies[1])).not.toContain("view_pages");
    expect(bodies[1].tools[0].functionDeclarations.map((tool) => tool.name)).toEqual(["generate_image", "generate_graph"]);
    expect(turnText(bodies[1].contents[0])).toContain("Figure 1: sales by region (chart)");
  });

  it("keeps the normal chat, with its image and graph hand-off, for a file that has no pages to look at", async () => {
    const largeFiles = createServerLargeFiles("npm");
    const bodies = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sse([{ candidates: [{ content: { parts: [{ text: "Two." }] }, finishReason: "STOP" }] }]);
    });
    const app = createApp({ fetchImpl, largeFiles });
    const upload = await request(app).post("/api/documents").set("Content-Type", "application/octet-stream").set("X-File-Name", "app.log").send(Buffer.from(log(500)));
    await request(app).post("/api/chat/stream").send(chatBody(upload.body.id));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(bodies[0].tools[0].functionDeclarations.map((tool) => tool.name)).toEqual(["generate_image", "generate_graph"]);
    expect(turnText(bodies[0].contents[0])).toContain("deadlock detected on table orders (tx 250)");
  });

  it("keeps the selected Interactions API for a PDF that fits", async () => {
    const largeFiles = createServerLargeFiles("npm");
    const fetchImpl = vi.fn(async () => sse([
      { event_type: "interaction.start", interaction: { id: "int_1" } },
      { event_type: "step.start", index: 0, step: { type: "model_output", content: [{ type: "text", text: "South." }] } },
      { event_type: "interaction.completed", interaction: { id: "int_1", status: "completed" } },
    ]));
    const app = createApp({ fetchImpl, largeFiles });
    const meta = await upload(app, await pdf(REPORT));
    const response = await request(app).post("/api/chat/stream").send(reportBody(meta.id, { interactions: { ...DEFAULT_INTERACTIONS, googleSearch: true } }));
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/\/interactions$/);
    expect(init.body).toContain("Figure 1: sales by region (chart)");
    expect(init.body).not.toContain("view_pages");
  });

  it("offers page views next to search for a PDF that does not fit, unless they are off", async () => {
    vi.stubEnv("LARGE_FILES_INLINE_TOKENS", "10");
    const largeFiles = createServerLargeFiles("npm");
    const bodies = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sse([{ candidates: [{ content: { parts: [{ text: "South." }] }, finishReason: "STOP" }] }]);
    });
    const app = createApp({ fetchImpl, largeFiles });
    const meta = await upload(app, await pdf(REPORT));
    const search = ["search_document", "read_document", "get_document_overview", "analyze_whole_document"];

    await request(app).post("/api/chat/stream").send(reportBody(meta.id));
    expect(bodies[0].tools[0].functionDeclarations.map((tool) => tool.name)).toEqual([...search, "view_pages"]);
    expect(turnText(bodies[0].contents[0])).toContain("--- Large attached file: report.pdf ---");
    expect(turnText(bodies[0].contents[0])).toContain("look at the page with view_pages");

    vi.stubEnv("LARGE_FILES_KEEP_PDFS", "0");
    await request(app).post("/api/chat/stream").send(reportBody(meta.id));
    expect(bodies[1].tools[0].functionDeclarations.map((tool) => tool.name)).toEqual(search);
    expect(JSON.stringify(bodies[1])).not.toContain("view_pages");
  });

  it("says so when the request is blocked or no answer comes", async () => {
    const largeFiles = createServerLargeFiles("npm");
    const replies = [];
    const fetchImpl = vi.fn(async () => sse(replies.shift() ?? [{ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }]));
    const app = createApp({ fetchImpl, largeFiles });
    const meta = await upload(app, await pdf(REPORT));
    const answer = async () => events((await request(app).post("/api/chat/stream").send(reportBody(meta.id))).text)
      .filter((event) => event.event === "delta").map((event) => event.data.text).join("");

    replies.push([{ promptFeedback: { blockReason: "SAFETY" } }]);
    expect(await answer()).toBe("The request was blocked (SAFETY).");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A remark before a look is not an answer: the model is asked once more, and still says nothing.
    replies.push([{ candidates: [{ content: { parts: [{ text: "Let me look." }, { functionCall: { name: "view_pages", args: { document_id: meta.id, from_page: 2 } } }] } }] }]);
    expect(await answer()).toBe("Let me look.\n\nThe model finished without an answer (MAX_TOKENS). Try asking more specifically.");
  });

  it("leaves a note where a file was attached later in the conversation", async () => {
    const largeFiles = createServerLargeFiles("npm");
    const bodies = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return sse([{ candidates: [{ content: { parts: [{ text: "South." }] }, finishReason: "STOP" }] }]);
    });
    const app = createApp({ fetchImpl, largeFiles });
    const meta = await upload(app, await pdf(REPORT));
    await request(app).post("/api/chat/stream").send(reportBody(meta.id, { messages: [
      { role: "user", content: "Hello." },
      { role: "assistant", content: "Hi." },
      { role: "user", content: "", files: [{ kind: "document", name: "report.pdf", mimeType: "application/pdf", documentId: meta.id }] },
    ] }));
    const [first, , last] = bodies[0].contents;
    expect(turnText(first)).toMatch(/^--- Attached file: report\.pdf[^]*Hello\.$/);
    expect(turnText(last)).toBe("(Attached file: report.pdf. Its text or summary card is at the start of this conversation.)");

    // A first message that was only the file: its text stands in for the message, with no empty part beside it.
    await request(app).post("/api/chat/stream").send(reportBody(meta.id, { messages: [
      { role: "user", content: "", files: [{ kind: "document", name: "report.pdf", mimeType: "application/pdf", documentId: meta.id }] },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "Which region has the tallest bar?" },
    ] }));
    const onlyFile = bodies[1].contents[0];
    expect(onlyFile.parts).toHaveLength(1);
    expect(onlyFile.parts[0].text).toMatch(/^--- Attached file: report\.pdf/);
    expect(JSON.stringify(bodies[1])).not.toContain("(Attached file:");
  });
});

describe("kept PDFs without a document", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "gemini-prep-orphans-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("removes a kept PDF whose document is gone, once it is an hour old", async () => {
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    const id = (letter: string) => `doc_${letter.repeat(32)}`;
    const write = async (name: string, modified?: Date) => {
      await writeFile(path.join(directory, name), "x");
      if (modified) await utimes(path.join(directory, name), modified, modified);
    };
    await write(`${id("a")}.bin`, old);
    await write(`${id("b")}.bin`, old);
    await write(`${id("b")}.json`, old);
    // Still being uploaded: its document is written after it.
    await write(`${id("c")}.bin`);
    await write("notes.bin", old);
    await write(`${id("d")}.txt`, old);

    expect(await removeOrphanOriginals(directory, now)).toBe(1);
    expect((await readdir(directory)).sort()).toEqual([`${id("b")}.bin`, `${id("b")}.json`, `${id("c")}.bin`, `${id("d")}.txt`, "notes.bin"].sort());
    expect(await removeOrphanOriginals(path.join(directory, "missing"), now)).toBe(0);
  });
});
