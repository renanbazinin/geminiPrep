import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamRequest } from "../../shared/contracts.js";
import { DEFAULT_INTERACTIONS, parseInteractionOptions } from "../../shared/interactions.js";
import { createApp } from "../app.js";
import { buildInteractionBody } from "./interactions.js";
import { resolveGeminiChatModels } from "../catalog.js";

function body(extra: Partial<ChatStreamRequest> = {}): ChatStreamRequest {
  return { provider: "gemini", model: resolveGeminiChatModels()[0]!.id, temperature: 1, maxOutputTokens: 8192,
    interactions: { ...DEFAULT_INTERACTIONS }, messages: [{ role: "user", content: "Hello" }], ...extra };
}

// Fixtures follow Google's v1 OpenAPI lifecycle and step event schemas (2026-10-08).
const created = { event_type: "interaction.created", interaction: { id: "turn_1", status: "in_progress" } };
const start = { event_type: "step.start", index: 0, step: { type: "model_output" } };
const delta = { event_type: "step.delta", index: 0, delta: { type: "text", text: "Hello back" } };
const completed = { event_type: "interaction.completed", interaction: { id: "turn_1", status: "completed", usage: { total_tokens: 42, total_cached_tokens: 12 } } };
function stream(events: unknown[], split = false) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
function fetchMock(events: unknown[] = [created, start, delta, completed], split = false) {
  return vi.fn<typeof fetch>().mockImplementation(async () => stream(events, split));
}
function eventsFrom(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.trim().split("\n\n").map((block) => ({
    event: block.split("\n")[0]!.slice(7),
    data: JSON.parse(block.split("\n")[1]!.slice(6)) as Record<string, unknown>,
  }));
}
beforeEach(() => vi.stubEnv("GEMINI_API_KEY", "test-secret-only"));
afterEach(() => vi.unstubAllEnvs());

describe("Interactions request mapping", () => {
  it("maps imported history and attachments to typed steps", () => {
    const result = buildInteractionBody(body({ messages: [
      { role: "user", content: "Read", files: [{ kind: "inlineData", name: "a.pdf", mimeType: "application/pdf", data: "YQ==" }, { kind: "text", name: "notes.txt", mimeType: "text/plain", text: "notes" }] },
      { role: "assistant", content: "Read it", files: [{ kind: "inlineData", name: "image.png", mimeType: "image/png", data: "YQ==" }] },
      { role: "user", content: "Summarize" },
    ] }));
    expect(result.input).toMatchObject([
      { type: "user_input", content: [{ type: "text" }, { type: "document", mime_type: "application/pdf", data: "YQ==" }, { type: "text" }] },
      { type: "model_output", content: [{ type: "text" }, { type: "image" }] },
      { type: "user_input" },
    ]);
  });

  it("resends settings and tools while referencing a previous interaction", () => {
    const result = buildInteractionBody(body({ previousInteractionId: "previous_123", systemInstruction: "Be brief",
      interactions: { ...DEFAULT_INTERACTIONS, googleSearch: true, codeExecution: true, seed: 0, stopSequences: ["END"], thinkingLevel: "medium", thinkingSummaries: "auto", responseFormat: "json", responseSchema: '{"type":"object"}' },
    }));
    expect(result).toMatchObject({ previous_interaction_id: "previous_123", system_instruction: "Be brief", store: true,
      tools: [{ type: "google_search" }, { type: "code_execution" }],
      generation_config: { seed: 0, stop_sequences: ["END"], thinking_level: "medium", thinking_summaries: "auto" },
      response_format: { type: "text", mime_type: "application/json", schema: { type: "object" } },
    });
    expect(result.generation_config).not.toHaveProperty("temperature");
    expect(result.generation_config).not.toHaveProperty("top_p");
  });

  it("includes deprecated sampling controls only with beta", () => {
    const result = buildInteractionBody(body({ temperature: 0, interactions: { ...DEFAULT_INTERACTIONS, apiVersion: "v1beta", topP: 0 } }));
    expect(result.generation_config).toMatchObject({ temperature: 0, top_p: 0 });
  });

  it("uses native image output and ignores text-only configuration for images", () => {
    const result = buildInteractionBody(body({ tool: "image", interactions: { ...DEFAULT_INTERACTIONS, googleSearch: true, imageAspectRatio: "16:9", imageSize: "2K", responseFormat: "json" } }));
    expect(result).not.toHaveProperty("tools");
    expect(result.generation_config).not.toHaveProperty("thinking_level");
    expect(result.response_format).toEqual([{ type: "text" }, { type: "image", delivery: "inline", aspect_ratio: "16:9", image_size: "2K" }]);
  });

  it.each([
    { stateful: true, store: false }, { seed: 1.2 }, { topP: 1.1 }, { googleSearch: "yes" },
    { apiVersion: "https://example.org" }, { thinkingLevel: "extreme" }, { stopSequences: [""] },
    { responseFormat: "json", responseSchema: "[1]" }, { responseFormat: "json", responseSchema: "{" }, { toolChoice: "any" },
  ])("rejects invalid controls %j", (extra) => {
    expect(() => parseInteractionOptions({ ...DEFAULT_INTERACTIONS, ...extra })).toThrow();
  });
});

describe("Interactions HTTP streaming", () => {
  it("streams fragmented SSE, redacts credentials and persists only a completed ID", async () => {
    const provider = fetchMock([created, start, delta, completed], true);
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body());
    expect(response.status).toBe(200);
    expect(provider.mock.calls[0]![0]).toBe("https://generativelanguage.googleapis.com/v1/interactions");
    const events = eventsFrom(response.text);
    expect(events.find((event) => event.event === "delta")?.data).toEqual({ text: "Hello back" });
    expect(events.at(-1)).toMatchObject({ event: "done", data: { interactionId: "turn_1", interactionStatus: "completed", usage: { total_tokens: 42, total_cached_tokens: 12 } } });
    expect(response.text).not.toContain("test-secret-only");
    expect(response.text).toContain("[REDACTED]");
  });

  it("sends only the new input on a follow-up", async () => {
    const provider = fetchMock();
    await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ previousInteractionId: "turn_0" }));
    const sent = JSON.parse(String(provider.mock.calls[0]![1]?.body));
    expect(sent.previous_interaction_id).toBe("turn_0");
    expect(sent.input).toHaveLength(1);
  });

  it("does not promote a created ID when the stream is truncated", async () => {
    const response = await request(createApp({ fetchImpl: fetchMock([created, start, delta]) })).post("/api/chat/stream").send(body());
    expect(eventsFrom(response.text).at(-1)).toMatchObject({ event: "error" });
    expect(response.text).not.toContain("event: done");
  });

  it.each(["failed", "cancelled", "requires_action"])("does not accept terminal status %s as success", async (status) => {
    const provider = fetchMock([created, { ...completed, interaction: { id: "turn_1", status } }]);
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body());
    expect(eventsFrom(response.text).at(-1)?.event).toBe("error");
  });

  it("preserves partial output but cannot continue an incomplete interaction", async () => {
    const provider = fetchMock([created, start, delta, { ...completed, interaction: { id: "turn_1", status: "incomplete" } }]);
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body());
    const done = eventsFrom(response.text).at(-1)!;
    expect(done.data.finishReason).toBe("MAX_TOKENS");
    expect(done.data).not.toHaveProperty("interactionId");
  });

  it("honors storage opt-out and returns no reusable ID", async () => {
    const provider = fetchMock();
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ interactions: { ...DEFAULT_INTERACTIONS, stateful: false, store: false } }));
    expect(JSON.parse(String(provider.mock.calls[0]![1]?.body)).store).toBe(false);
    expect(eventsFrom(response.text).at(-1)?.data).not.toHaveProperty("interactionId");
  });

  it("keeps summaries separate from model text and excludes signatures", async () => {
    const provider = fetchMock([created,
      { event_type: "step.start", index: 1, step: { type: "thought" } },
      { event_type: "step.delta", index: 1, delta: { type: "text", text: "private thought" } },
      { event_type: "step.delta", index: 1, delta: { type: "thought_summary", content: { type: "text", text: "Summary" } } },
      { event_type: "step.delta", index: 1, delta: { type: "thought_signature", signature: "private-signature" } },
      start, delta, completed,
    ]);
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ interactions: { ...DEFAULT_INTERACTIONS, thinkingSummaries: "auto" } }));
    expect(eventsFrom(response.text).filter((event) => event.event === "thinking")).toEqual([{ event: "thinking", data: { text: "Summary" } }]);
    expect(response.text).not.toContain("private thought");
    expect(response.text).not.toContain("private-signature");
  });

  it("assembles fragmented image output once", async () => {
    const provider = fetchMock([created, start,
      { event_type: "step.delta", index: 0, delta: { type: "image", mime_type: "image/png", data: "YQ" } },
      { event_type: "step.delta", index: 0, delta: { type: "image", data: "==" } },
      { event_type: "step.stop", index: 0 }, completed,
    ]);
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ tool: "image" }));
    expect(eventsFrom(response.text).filter((event) => event.event === "image")).toEqual([{ event: "image", data: { mimeType: "image/png", data: "YQ==" } }]);
  });

  it("forwards deduplicated web citations and search suggestions while filtering unsafe URLs", async () => {
    const annotation = { type: "url_citation", url: "https://example.com/source", title: "Source" };
    const suggestions = { type: "google_search_result", result: [{ search_suggestions: "<div>Search suggestions</div>" }] };
    const provider = fetchMock([created, start,
      { event_type: "step.delta", index: 0, delta: { type: "text_annotation_delta", annotations: [annotation, annotation, { ...annotation, url: "javascript:alert(1)" }] } },
      { event_type: "step.delta", index: 1, delta: suggestions },
      { event_type: "step.start", index: 1, step: suggestions },
      delta, completed,
    ]);
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body());
    expect(eventsFrom(response.text).filter((event) => event.event === "grounding")).toEqual([
      { event: "grounding", data: { sources: [{ url: annotation.url, title: annotation.title }] } },
      { event: "grounding", data: { searchSuggestions: "<div>Search suggestions</div>" } },
    ]);
  });

  it("marks an expired reference for client recovery without retrying on the server", async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Previous interaction not found" } }), { status: 404 }));
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ previousInteractionId: "expired" }));
    expect(eventsFrom(response.text).at(-1)).toMatchObject({ event: "error", data: { code: "interaction_reference_invalid", status: 404 } });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 410])("checks the reference after an ambiguous 400 and flags a GET %s", async (status) => {
    const provider = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Request contains an invalid argument." } }), { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status }));
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ previousInteractionId: "expired" }));
    expect(provider.mock.calls[1]![0]).toBe("https://generativelanguage.googleapis.com/v1/interactions/expired?include_input=false");
    expect(provider.mock.calls[1]![1]?.method).toBe("GET");
    expect(eventsFrom(response.text).at(-1)?.data.code).toBe("interaction_reference_invalid");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("does not mistake an invalid API key reported as HTTP 400 for an expired conversation", async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }), { status: 400 }));
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ previousInteractionId: "maybe-valid" }));
    expect(eventsFrom(response.text).at(-1)?.data).not.toHaveProperty("code");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("keeps the original error when reference verification loses access or its network connection", async () => {
    for (const accessFailure of [true, false]) {
      const provider = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Invalid argument" } }), { status: 400 }));
      if (accessFailure) provider.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "API_KEY_INVALID" } }), { status: 400 }));
      else provider.mockRejectedValueOnce(new Error("Network disconnected"));
      const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ previousInteractionId: "maybe-valid" }));
      expect(eventsFrom(response.text).at(-1)?.data).toMatchObject({ message: "Invalid argument", status: 400 });
      expect(eventsFrom(response.text).at(-1)?.data).not.toHaveProperty("code");
      expect(provider).toHaveBeenCalledTimes(2);
    }
  });

  it.each([200, 401, 403, 429, 500])("does not discard a reference when verification returns %s", async (status) => {
    const provider = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Invalid model setting" } }), { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status }));
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ previousInteractionId: "maybe-valid" }));
    expect(eventsFrom(response.text).at(-1)?.data).not.toHaveProperty("code");
    expect(eventsFrom(response.text).at(-1)?.data.message).toBe("Invalid model setting");
  });

  it.each([
    { provider: "vertex", region: "us-central1" },
    { previousInteractionId: "bad\nid" },
    { previousInteractionId: "old", interactions: { ...DEFAULT_INTERACTIONS, stateful: false } },
    { previousInteractionId: "old", messages: [{ role: "assistant", content: "Already stored" }, { role: "user", content: "Next" }] },
  ])("rejects incompatible requests before calling the provider: %j", async (extra) => {
    const provider = fetchMock();
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send({ ...body(), ...extra });
    expect(response.status).toBe(400);
    expect(provider).not.toHaveBeenCalled();
  });
});
