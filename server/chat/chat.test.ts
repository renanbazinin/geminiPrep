// @ts-nocheck -- Fetch stream doubles intentionally implement only the behavior under test.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { resolveGeminiChatModels, resolveProbeRegions, resolveVertexChatModels } from "../catalog.js";
import { IMAGE_MODEL_ID, GRAPH_SYSTEM_PROMPT } from "../../shared/chat-tools.js";
import { validateChatRequest } from "./validation.js";
import {
  buildGenerateContentBody,
  createUpstreamRequest,
  describeUpstreamRequest,
  extractChunkFunctionCalls,
  extractChunkImages,
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

  it("accepts thinkingLevel and rejects any other value", () => {
    expect(validateChatRequest(validBody({ thinkingLevel: "low" }), catalogs()).thinkingLevel).toBe("low");
    expect(validateChatRequest(validBody(), catalogs()).thinkingLevel).toBeUndefined();
    expect(() => validateChatRequest(validBody({ thinkingLevel: "medium" }), catalogs()))
      .toThrow(/thinkingLevel must be low or high/);
  });

  it("accepts a cachedContent resource name in the request's own region", () => {
    const region = resolveProbeRegions()[0].id;
    const body = validBody({
      provider: "vertex",
      model: resolveVertexChatModels()[0].id,
      region,
      cachedContent: `projects/study-project/locations/${region}/cachedContents/cache_123`,
    });
    expect(validateChatRequest(body, catalogs()).cachedContent)
      .toBe(`projects/study-project/locations/${region}/cachedContents/cache_123`);
  });

  it("rejects a cache from a different location than the request", () => {
    const region = resolveProbeRegions()[0].id;
    const other = resolveProbeRegions().find((candidate) => candidate.id !== region)?.id ?? "us-central1";
    const body = validBody({
      provider: "vertex",
      model: resolveVertexChatModels()[0].id,
      region,
      cachedContent: `projects/study-project/locations/${other}/cachedContents/cache_123`,
    });
    expect(() => validateChatRequest(body, catalogs())).toThrow(/does not match the request region/);
  });

  it("rejects cachedContent on the Gemini API and malformed names", () => {
    expect(() => validateChatRequest(validBody({
      cachedContent: "projects/p/locations/global/cachedContents/cache_123",
    }), catalogs())).toThrow(/only supported on Vertex AI/);
    expect(() => validateChatRequest(validBody({
      provider: "vertex",
      model: resolveVertexChatModels()[0].id,
      region: resolveProbeRegions()[0].id,
      cachedContent: "cachedContents/cache_123",
    }), catalogs())).toThrow(/cachedContents resource name/);
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
    }), catalogs())).toThrow(/inlineData must be a PDF or image/);
  });

  it("rewrites image-tool requests onto gemini-3.1-flash-image and drops thinking", () => {
    const validated = validateChatRequest(validBody({
      tool: "image",
      thinkingLevel: "high",
    }), catalogs());
    expect(validated.model).toBe(IMAGE_MODEL_ID);
    expect(validated.thinkingLevel).toBeUndefined();
    expect(validated.tool).toBe("image");
    const body = buildGenerateContentBody(validated) as {
      generationConfig: Record<string, unknown>;
    };
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(body.generationConfig).not.toHaveProperty("thinkingConfig");
  });

  it("rejects the image model without the image tool", () => {
    expect(() => validateChatRequest(validBody({ model: IMAGE_MODEL_ID }), catalogs()))
      .toThrow(/not configured/);
  });

  it("forces Vertex image generation onto the global region", () => {
    const validated = validateChatRequest(validBody({
      provider: "vertex",
      model: resolveVertexChatModels()[0].id,
      region: "europe-west1",
      tool: "image",
    }), catalogs());
    expect(validated.region).toBe("global");
    expect(validated.model).toBe(IMAGE_MODEL_ID);
  });

  it("merges the Mermaid system prompt for the graph tool", () => {
    const body = buildGenerateContentBody(validateChatRequest(validBody({
      tool: "graph",
      systemInstruction: "Be concise",
    }), catalogs())) as { systemInstruction: { parts: Array<{ text: string }> }; generationConfig: Record<string, unknown> };
    expect(body.systemInstruction.parts[0].text).toContain("Be concise");
    expect(body.systemInstruction.parts[0].text).toContain(GRAPH_SYSTEM_PROMPT);
    expect(body.generationConfig).not.toHaveProperty("responseModalities");
  });

  it("drops cachedContent when a chat tool is selected", () => {
    const region = resolveProbeRegions()[0].id;
    const validated = validateChatRequest(validBody({
      provider: "vertex",
      model: resolveVertexChatModels()[0].id,
      region,
      tool: "graph",
      cachedContent: `projects/study-project/locations/${region}/cachedContents/cache_123`,
    }), catalogs());
    expect(validated.cachedContent).toBeUndefined();
    expect(validated.model).toBe(resolveVertexChatModels()[0].id);
  });

  it("accepts generated images on assistant history", () => {
    const validated = validateChatRequest(validBody({
      tool: "image",
      messages: [
        { role: "user", content: "Draw a cat" },
        { role: "assistant", content: "", files: [{ kind: "inlineData", name: "cat.png", mimeType: "image/png", data: "QUJDRA==" }] },
        { role: "user", content: "Make it orange" },
      ],
    }), catalogs());
    expect(validated.messages[1].files?.[0]).toMatchObject({ mimeType: "image/png" });
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

  it("maps assistant images into provider inlineData parts", () => {
    const body = buildGenerateContentBody(validateChatRequest(validBody({
      tool: "image",
      messages: [
        { role: "user", content: "Draw a cat" },
        { role: "assistant", content: "", files: [{ kind: "inlineData", name: "cat.png", mimeType: "image/png", data: "QUJDRA==" }] },
        { role: "user", content: "Make it orange" },
      ],
    }), catalogs())) as { contents: Array<{ parts: Array<Record<string, unknown>> }> };
    expect(body.contents[1].parts).toEqual([
      { inlineData: { mimeType: "image/png", data: "QUJDRA==" } },
    ]);
  });

  it("sends function declarations in AUTO mode when no tool is forced", () => {
    const body = buildGenerateContentBody(validateChatRequest(validBody(), catalogs())) as {
      tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
      toolConfig: { functionCallingConfig: { mode: string } };
      generationConfig: Record<string, unknown>;
    };
    expect(body.tools[0].functionDeclarations.map((entry) => entry.name)).toEqual([
      "generate_image",
      "generate_graph",
    ]);
    expect(body.toolConfig.functionCallingConfig.mode).toBe("AUTO");
    expect(body.generationConfig).not.toHaveProperty("responseModalities");
  });

  it("does not attach planner tools when a specialist tool is forced", () => {
    const body = buildGenerateContentBody(validateChatRequest(validBody({ tool: "image" }), catalogs()));
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("toolConfig");
    expect(body.generationConfig).toMatchObject({ responseModalities: ["TEXT", "IMAGE"] });
  });

  it("sends thinkingConfig inside generationConfig only when set", () => {
    const withLevel = buildGenerateContentBody(validateChatRequest(validBody({ thinkingLevel: "low" }), catalogs()));
    expect(withLevel.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: "low" } });
    expect(buildGenerateContentBody(validateChatRequest(validBody(), catalogs())).generationConfig)
      .not.toHaveProperty("thinkingConfig");
  });

  it("drops cachedContent on the Auto planner so function declarations can be sent", () => {
    const region = resolveProbeRegions()[0].id;
    const name = `projects/study-project/locations/${region}/cachedContents/cache_123`;
    const body = buildGenerateContentBody(validateChatRequest(validBody({
      provider: "vertex",
      model: resolveVertexChatModels()[0].id,
      region,
      systemInstruction: "Be concise",
      cachedContent: name,
    }), catalogs())) as {
      tools?: unknown;
      systemInstruction?: { parts: Array<{ text: string }> };
    };
    expect(body).not.toHaveProperty("cachedContent");
    expect(body.tools).toBeTruthy();
    expect(body.systemInstruction?.parts[0].text).toBe("Be concise");
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

  it("extracts image parts from upstream chunks", () => {
    expect(extractChunkImages({ candidates: [{ content: { parts: [
      { text: "here" },
      { inlineData: { mimeType: "image/png", data: "QUJDRA==" } },
    ] } }] })).toEqual([{ mimeType: "image/png", data: "QUJDRA==" }]);
  });

  it("extracts functionCall parts from upstream chunks", () => {
    expect(extractChunkFunctionCalls({ candidates: [{ content: { parts: [
      { functionCall: { name: "generate_image", args: { prompt: "a monkey" } } },
    ] } }] })).toEqual([{ name: "generate_image", args: { prompt: "a monkey" } }]);
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

  it("streams image events from inlineData parts", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([
      "data: {\"candidates\":[{\"content\":{\"parts\":[{\"inlineData\":{\"mimeType\":\"image/png\",\"data\":\"QUJDRA==\"}}]}}]}\n\n",
      "data: {\"candidates\":[{\"finishReason\":\"STOP\"}]}\n\n",
    ]));
    const response = await request(createApp({ fetchImpl })).post("/api/chat/stream").send(validBody({ tool: "image" }));
    expect(response.status).toBe(200);
    expect(response.text).toContain("event: image");
    expect(response.text).toContain('"mimeType":"image/png"');
    expect(response.text).toContain('"data":"QUJDRA=="');
  });

  it("hands an Auto generate_image functionCall to the image model on the same stream", async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes(IMAGE_MODEL_ID)) {
        return sseResponse([
          "data: {\"candidates\":[{\"content\":{\"parts\":[{\"inlineData\":{\"mimeType\":\"image/png\",\"data\":\"QUJDRA==\"}}]},\"finishReason\":\"STOP\"}]}\n\n",
        ]);
      }
      return sseResponse([
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"generate_image\",\"args\":{\"prompt\":\"a monkey\"}}}]},\"finishReason\":\"STOP\"}]}\n\n",
      ]);
    });
    const response = await request(createApp({ fetchImpl })).post("/api/chat/stream").send(validBody({
      messages: [{ role: "user", content: "generate me image of monkey" }],
    }));
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain(IMAGE_MODEL_ID);
    const specialistBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(specialistBody.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(specialistBody.contents.at(-1).parts[0].text).toBe("a monkey");
    expect(specialistBody).not.toHaveProperty("tools");
    expect(response.text).toContain("event: tool");
    expect(response.text).toContain('"id":"image"');
    expect(response.text).toContain("event: image");
    expect(response.text).toContain('"data":"QUJDRA=="');
  });

  it("hands an Auto generate_graph functionCall to the chat model with the Mermaid prompt", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.systemInstruction?.parts?.[0]?.text?.includes("Mermaid")) {
        return sseResponse([
          "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"```mermaid\\ngraph TD; A-->B\\n```\"}]},\"finishReason\":\"STOP\"}]}\n\n",
        ]);
      }
      return sseResponse([
        "data: {\"candidates\":[{\"content\":{\"parts\":[{\"functionCall\":{\"name\":\"generate_graph\",\"args\":{\"request\":\"auth flow\"}}}]},\"finishReason\":\"STOP\"}]}\n\n",
      ]);
    });
    const response = await request(createApp({ fetchImpl })).post("/api/chat/stream").send(validBody({
      messages: [{ role: "user", content: "draw a flowchart of auth" }],
    }));
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const specialistBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(specialistBody.systemInstruction.parts[0].text).toContain(GRAPH_SYSTEM_PROMPT);
    expect(specialistBody.contents.at(-1).parts[0].text).toBe("auth flow");
    expect(specialistBody).not.toHaveProperty("tools");
    expect(String(fetchImpl.mock.calls[1][0])).not.toContain(IMAGE_MODEL_ID);
    expect(response.text).toContain('"id":"graph"');
    expect(response.text).toContain("```mermaid");
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
