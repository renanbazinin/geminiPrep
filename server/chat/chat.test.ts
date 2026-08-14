// @ts-nocheck -- Fetch stream doubles intentionally implement only the behavior under test.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resolveGeminiChatModels, resolveProbeRegions, resolveVertexChatModels } from "../catalog.js";
import { validateChatRequest } from "./validation.js";
import {
  buildGenerateContentBody,
  createUpstreamRequest,
  describeUpstreamRequest,
  extractChunkText,
  geminiStreamUrl,
  parseSseJson,
} from "./upstream.js";

function catalogs() {
  return {
    vertexModels: resolveVertexChatModels(),
    geminiModels: resolveGeminiChatModels(),
    regions: resolveProbeRegions(),
  };
}

function validBody(extra = {}) {
  return {
    provider: "gemini",
    model: resolveGeminiChatModels()[0].id,
    temperature: 1,
    maxOutputTokens: 1024,
    messages: [{ role: "user", content: "Hello" }],
    ...extra,
  };
}

function sseResponse(blocks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      blocks.forEach((block) => controller.enqueue(encoder.encode(block)));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("chat validation", () => {
  it("accepts a configured Gemini request", () => {
    expect(validateChatRequest(validBody(), catalogs())).toMatchObject({ provider: "gemini" });
  });

  it("accepts Vertex only with a configured region", () => {
    const body = validBody({
      provider: "vertex",
      model: resolveVertexChatModels()[0].id,
      region: resolveProbeRegions()[0].id,
    });
    expect(validateChatRequest(body, catalogs()).region).toBe(resolveProbeRegions()[0].id);
  });

  it("rejects an unknown model", () => {
    expect(() => validateChatRequest(validBody({ model: "unknown" }), catalogs())).toThrow(/not configured/);
  });

  it("rejects an unknown region", () => {
    const body = validBody({ provider: "vertex", model: resolveVertexChatModels()[0].id, region: "moon-1" });
    expect(() => validateChatRequest(body, catalogs())).toThrow(/not configured/);
  });

  it("requires the last message to be a user turn", () => {
    expect(() => validateChatRequest(validBody({ messages: [{ role: "assistant", content: "Hi" }] }), catalogs())).toThrow(/last message/);
  });

  it("bounds practical generation controls", () => {
    expect(() => validateChatRequest(validBody({ temperature: 3 }), catalogs())).toThrow(/temperature/);
    expect(() => validateChatRequest(validBody({ maxOutputTokens: 0 }), catalogs())).toThrow(/maxOutputTokens/);
  });

  it("accepts multiple text and native PDF file parts", () => {
    const validated = validateChatRequest(validBody({
      messages: [{
        role: "user",
        content: "Compare these files",
        files: [
          { kind: "text", name: "notes.md", mimeType: "text/markdown", text: "# Notes" },
          { kind: "text", name: "data.json", mimeType: "application/json", text: "{\"ok\":true}" },
          { kind: "inlineData", name: "report.pdf", mimeType: "application/pdf", data: "JVBERi0xCg==" },
        ],
      }],
    }), catalogs());
    expect(validated.messages[0].files).toHaveLength(3);
  });

  it("rejects unsupported inline file types", () => {
    expect(() => validateChatRequest(validBody({
      messages: [{
        role: "user",
        content: "Read this",
        files: [{ kind: "inlineData", name: "slides.pptx", mimeType: "application/zip", data: "eA==" }],
      }],
    }), catalogs())).toThrow(/inlineData must be a PDF/);
  });
});

describe("provider request adapters", () => {
  it("builds the Gemini stream endpoint", () => {
    expect(geminiStreamUrl("gemini-test", "v1beta")).toContain("/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
  });

  it("maps assistant messages to the model role", () => {
    const body = buildGenerateContentBody(validateChatRequest(validBody({
      systemInstruction: "Be concise",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "Continue" },
      ],
    }), catalogs()));
    expect(body.contents[1].role).toBe("model");
    expect(body.systemInstruction.parts[0].text).toBe("Be concise");
  });

  it("maps extracted text and PDF attachments into provider parts", () => {
    const body = buildGenerateContentBody(validateChatRequest(validBody({
      messages: [{
        role: "user",
        content: "Summarize",
        files: [
          { kind: "text", name: "brief.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: "Extracted Word text" },
          { kind: "inlineData", name: "visual.pdf", mimeType: "application/pdf", data: "JVBERi0xCg==" },
        ],
      }],
    }), catalogs())) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(body.contents[0].parts).toEqual([
      { text: "Summarize" },
      { text: expect.stringContaining("Extracted Word text") },
      { text: "Attached PDF: visual.pdf" },
      { inlineData: { mimeType: "application/pdf", data: "JVBERi0xCg==" } },
    ]);
  });

  it("keeps API keys in headers, not request bodies", () => {
    const upstream = createUpstreamRequest({
      request: validateChatRequest(validBody(), catalogs()),
      project: null,
      geminiApiKey: "secret",
    });
    expect(upstream.init.headers["x-goog-api-key"]).toBe("secret");
    expect(upstream.init.body).not.toContain("secret");
    const debug = describeUpstreamRequest(upstream);
    expect(debug.headers["x-goog-api-key"]).toBe("[REDACTED]");
    expect(JSON.stringify(debug)).not.toContain("secret");
    expect(debug.body).toMatchObject({ contents: [{ role: "user" }] });
  });

  it("redacts bearer credentials and secret URL parameters in debug data", () => {
    const debug = describeUpstreamRequest({
      url: "https://example.test/stream?alt=sse&key=url-secret",
      init: {
        method: "POST",
        headers: { Authorization: "Bearer access-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "safe" }),
      },
    });
    expect(debug.headers.authorization).toBe("[REDACTED]");
    expect(debug.url).not.toContain("url-secret");
    expect(JSON.stringify(debug)).not.toContain("access-secret");
  });

  it("omits thought parts from visible text", () => {
    expect(extractChunkText({ candidates: [{ content: { parts: [
      { text: "private", thought: true },
      { text: "visible" },
    ] } }] })).toBe("visible");
  });
});

describe("SSE parsing", () => {
  it("parses JSON events split across transport chunks", async () => {
    const response = sseResponse([
      "data: {\"candidates\":[{\"content\":",
      "{\"parts\":[{\"text\":\"Hi\"}]}}]}\n\n",
    ]);
    const values = [];
    for await (const value of parseSseJson(response.body)) values.push(value);
    expect(extractChunkText(values[0])).toBe("Hi");
  });

  it("ignores a terminal DONE marker", async () => {
    const response = sseResponse(["data: [DONE]\n\n"]);
    const values = [];
    for await (const value of parseSseJson(response.body)) values.push(value);
    expect(values).toEqual([]);
  });
});

describe("chat API", () => {
  const previousKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
  });

  afterEach(() => {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  });

  it("streams normalized meta, delta, and done events", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      "data: {\"responseId\":\"r1\",\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Hello\"}]}}]}\n\n",
      "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\" world\"}]},\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"totalTokenCount\":504,\"cachedContentTokenCount\":500}}\n\n",
    ]));
    const response = await request(createApp({ fetchImpl })).post("/api/chat/stream").send(validBody());
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain("event: meta");
    expect(response.text).toContain('data: {"text":"Hello"}');
    expect(response.text).toContain('data: {"text":" world"}');
    expect(response.text).toContain("event: done");
    expect(response.text).toContain('"providerRequest"');
    expect(response.text).toContain('"x-goog-api-key":"[REDACTED]"');
    expect(response.text).toContain('"chunkCount":2');
    expect(response.text).toContain('"textCharacters":11');
    expect(response.text).toContain('"cachedContentTokenCount":500');
    expect(response.text).not.toContain("test-key");
  });

  it("normalizes upstream HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "model unavailable" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    ));
    const response = await request(createApp({ fetchImpl })).post("/api/chat/stream").send(validBody());
    expect(response.status).toBe(200);
    expect(response.text).toContain("event: error");
    expect(response.text).toContain("model unavailable");
  });

  it("returns a normal JSON error before streaming when the API key is absent", async () => {
    delete process.env.GEMINI_API_KEY;
    const response = await request(createApp()).post("/api/chat/stream").send(validBody());
    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/GEMINI_API_KEY/);
  });

  it("never exposes credentials from the public config endpoint", async () => {
    const response = await request(createApp()).get("/api/config");
    expect(response.status).toBe(200);
    expect(response.body.providers.gemini.ready).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("test-key");
  });
});
