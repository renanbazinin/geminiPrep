import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamRequest, InteractionOptions } from "../../shared/contracts.js";
import { DEFAULT_INTERACTIONS } from "../../shared/interactions.js";
import { GRAPH_SYSTEM_PROMPT, IMAGE_MODEL_ID } from "../../shared/chat-tools.js";
import { GEMINI_4_MIN_OUTPUT_TOKENS, PRO_MODEL } from "../../shared/gemini-4.js";
import { createApp } from "../app.js";
import { buildPublicConfig } from "../config.js";
import { resolveGeminiChatModels, resolveImplicitCacheModels, resolveProbeModels, resolveVertexChatModels } from "../catalog.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import { buildInteractionBody } from "./interactions.js";
import { buildGenerateContentBody } from "./upstream.js";

vi.mock("../vertex-auth.js", () => ({ getVertexAccessToken: vi.fn() }));

const GEMINI_4 = PRO_MODEL.id;

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-secret-only");
  vi.stubEnv("GCP_PROJECT", "project-one");
  for (const name of ["GEMINI_CHAT_MODELS", "VERTEX_CHAT_MODELS", "VERTEX_PROBE_MODELS", "GEMINI_API_VERSION"]) vi.stubEnv(name, "");
  vi.mocked(getVertexAccessToken).mockReset().mockResolvedValue("test-adc-token");
});
afterEach(() => vi.unstubAllEnvs());

/** A turn the browser sends with the Gemini 4 toggle on; the defaults mirror fresh browser settings. */
function turn(extra: Partial<ChatStreamRequest> = {}): ChatStreamRequest {
  return { provider: "gemini", model: GEMINI_4, temperature: 1, maxOutputTokens: 8192,
    messages: [{ role: "user", content: "Hello" }], ...extra };
}
const interactions = (extra: Partial<InteractionOptions> = {}): InteractionOptions => ({ ...DEFAULT_INTERACTIONS, ...extra });

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
const interactionReply = (text: string, id = "argon_turn_1") => sse([
  { event_type: "interaction.created", interaction: { id, status: "in_progress" } },
  { event_type: "step.start", index: 0, step: { type: "thought" } },
  { event_type: "step.start", index: 1, step: { type: "model_output" } },
  { event_type: "step.delta", index: 1, delta: { type: "text", text } },
  { event_type: "interaction.completed", interaction: { id, status: "completed", usage: { total_tokens: 64, total_thought_tokens: 40 } } },
]);
const generateContentReply = (text: string) => sse([
  { candidates: [{ content: { parts: [{ text: "hidden reasoning", thought: true }] } }] },
  { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], responseId: "argon-response", usageMetadata: { thoughtsTokenCount: 40 } },
]);

function events(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.trim().split("\n\n").map((block) => ({
    event: block.split("\n")[0]!.slice(7),
    data: JSON.parse(block.split("\n")[1]!.slice(6)) as Record<string, unknown>,
  }));
}
function sentBody(provider: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): Record<string, unknown> {
  return JSON.parse(String(provider.mock.calls[call]![1]?.body)) as Record<string, unknown>;
}
/** Interactions calls it generation_config; Generate Content calls it generationConfig. */
function generationConfig(body: Record<string, unknown>): Record<string, unknown> {
  return (body.generation_config ?? body.generationConfig) as Record<string, unknown>;
}

describe("Gemini 4 in the model catalog", () => {
  it("is offered by both providers without becoming the default for fresh settings", () => {
    const config = buildPublicConfig();
    for (const provider of ["vertex", "gemini"] as const) {
      expect(config.providers[provider].models.map((model) => model.id)).toContain(GEMINI_4);
    }
    expect(config.defaults.vertexModel).not.toBe(GEMINI_4);
    expect(config.defaults.geminiModel).not.toBe(GEMINI_4);
  });

  it("stays available when an .env list narrows the regular model menu", () => {
    vi.stubEnv("GEMINI_CHAT_MODELS", "gemini-3.8-flash");
    vi.stubEnv("VERTEX_CHAT_MODELS", "gemini-3.6-flash");
    expect(resolveGeminiChatModels().map((model) => model.id)).toEqual(["gemini-3.8-flash", GEMINI_4]);
    expect(resolveVertexChatModels().map((model) => model.id)).toEqual(["gemini-3.6-flash", GEMINI_4]);
  });

  it("is listed once even when an .env list already names it", () => {
    vi.stubEnv("GEMINI_CHAT_MODELS", `${GEMINI_4},gemini-3.8-flash`);
    expect(resolveGeminiChatModels().filter((model) => model.id === GEMINI_4)).toHaveLength(1);
  });

  it("joins the region lab and the implicit-cache lab, but not the explicit-cache list", () => {
    expect(resolveProbeModels().map((model) => model.id)).toContain(GEMINI_4);
    expect(resolveImplicitCacheModels().map((model) => model.id)).toContain(GEMINI_4);
    expect(buildPublicConfig().providers.vertex.models.find((model) => model.id === GEMINI_4)).toEqual(PRO_MODEL);
  });
});

describe("every chat request path works with Gemini 4", () => {
  const paths = [
    { name: "Gemini API · Interactions v1", body: turn({ interactions: interactions() }),
      url: "https://generativelanguage.googleapis.com/v1/interactions", reply: interactionReply },
    { name: "Gemini API · Interactions v1beta", body: turn({ interactions: interactions({ apiVersion: "v1beta", topP: 0.5 }) }),
      url: "https://generativelanguage.googleapis.com/v1beta/interactions", reply: interactionReply },
    { name: "Vertex · Interactions (global)", body: turn({ provider: "vertex", region: "global", interactionProject: "project-one", interactions: interactions({ topP: 0.5 }) }),
      url: "https://aiplatform.googleapis.com/v1beta1/projects/project-one/locations/global/interactions", reply: interactionReply },
    { name: "Gemini API · Generate Content", body: turn(),
      url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_4}:streamGenerateContent?alt=sse`, reply: generateContentReply },
    { name: "Vertex · Generate Content (global)", body: turn({ provider: "vertex", region: "global" }),
      url: `https://aiplatform.googleapis.com/v1/projects/project-one/locations/global/publishers/google/models/${GEMINI_4}:streamGenerateContent?alt=sse`, reply: generateContentReply },
    { name: "Vertex · Generate Content (EU multi-region)", body: turn({ provider: "vertex", region: "eu" }),
      url: `https://aiplatform.eu.rep.googleapis.com/v1/projects/project-one/locations/eu/publishers/google/models/${GEMINI_4}:streamGenerateContent?alt=sse`, reply: generateContentReply },
    { name: "Vertex · Generate Content (US multi-region)", body: turn({ provider: "vertex", region: "us" }),
      url: `https://aiplatform.us.rep.googleapis.com/v1/projects/project-one/locations/us/publishers/google/models/${GEMINI_4}:streamGenerateContent?alt=sse`, reply: generateContentReply },
  ];

  it.each(paths)("$name", async ({ body, url, reply }) => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(reply("Hi from Gemini 4"));
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body);

    expect(response.status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(provider.mock.calls[0]![0]).toBe(url);
    const sent = sentBody(provider);
    if ("model" in sent) expect(sent.model).toBe(GEMINI_4);
    const config = generationConfig(sent);
    expect(config).not.toHaveProperty("temperature");
    expect(config).not.toHaveProperty("top_p");
    expect(config.max_output_tokens ?? config.maxOutputTokens).toBe(GEMINI_4_MIN_OUTPUT_TOKENS);

    const streamed = events(response.text);
    expect(streamed[0]).toMatchObject({ event: "meta", data: { model: GEMINI_4 } });
    expect(streamed.filter((event) => event.event === "delta").map((event) => event.data.text)).toEqual(["Hi from Gemini 4"]);
    expect(streamed.at(-1)?.event).toBe("done");
    expect(response.text).not.toContain("hidden reasoning");
    expect(response.text).not.toContain("test-secret-only");
    expect(response.text).not.toContain("test-adc-token");
  });

  it("continues a stored Gemini 4 conversation by sending only the new turn", async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(interactionReply("Your name is Dana", "argon_turn_2"));
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(turn({
      interactions: interactions(), previousInteractionId: "argon_turn_1",
      messages: [{ role: "user", content: "What is my name?" }],
    }));
    const sent = sentBody(provider);
    expect(sent).toMatchObject({ model: GEMINI_4, previous_interaction_id: "argon_turn_1", store: true });
    expect(sent.input).toHaveLength(1);
    expect(events(response.text).at(-1)).toMatchObject({ event: "done", data: { interactionId: "argon_turn_2", interactionStatus: "completed" } });
  });

  it("hands an image request from Gemini 4 to the image model without Gemini 4's rules", async () => {
    const provider = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse([{ candidates: [{ content: { parts: [{ functionCall: { name: "generate_image", args: { prompt: "a lighthouse at dusk" } } }] }, finishReason: "STOP" }] }]))
      .mockResolvedValueOnce(sse([{ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "YQ==" } }] }, finishReason: "STOP" }] }]));
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(turn({ messages: [{ role: "user", content: "Draw a lighthouse" }] }));

    expect(provider.mock.calls[0]![0]).toContain(`/models/${GEMINI_4}:`);
    expect(provider.mock.calls[1]![0]).toContain(`/models/${IMAGE_MODEL_ID}:`);
    expect(generationConfig(sentBody(provider, 1))).toMatchObject({ temperature: 1, maxOutputTokens: 8192, responseModalities: ["TEXT", "IMAGE"] });
    expect(events(response.text).map((event) => event.event)).toEqual(["meta", "tool", "image", "done"]);
  });

  it("shows Google's reason when the key cannot use Gemini 4, such as a free-tier key", async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 429, message: "Gemini 4 Argon is not available on the free tier." },
    }), { status: 429 }));
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(turn({ interactions: interactions() }));
    expect(events(response.text).at(-1)).toMatchObject({ event: "error", data: { status: 429, message: "Gemini 4 Argon is not available on the free tier." } });
  });
});

describe("Gemini 4 request rules", () => {
  it.each([
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
  ] as const)("sends thinking level %s as %s", (chosen, sent) => {
    const body = buildInteractionBody(turn({ interactions: interactions({ thinkingLevel: chosen }) }));
    expect(generationConfig(body).thinking_level).toBe(sent);
  });

  it("leaves the thinking level to the model by default, which is medium for Gemini 4", () => {
    expect(generationConfig(buildInteractionBody(turn({ interactions: interactions() })))).not.toHaveProperty("thinking_level");
  });

  it("raises only a too-small output limit and keeps a larger one", () => {
    expect(generationConfig(buildInteractionBody(turn({ maxOutputTokens: 1, interactions: interactions() }))).max_output_tokens).toBe(GEMINI_4_MIN_OUTPUT_TOKENS);
    expect(generationConfig(buildInteractionBody(turn({ maxOutputTokens: 60_000, interactions: interactions() }))).max_output_tokens).toBe(60_000);
    expect(generationConfig(buildGenerateContentBody(turn({ maxOutputTokens: 60_000 }))).maxOutputTokens).toBe(60_000);
  });

  it("keeps the Generate Content thinking level and the graph tool's diagram prompt", () => {
    const body = buildGenerateContentBody(turn({ tool: "graph", thinkingLevel: "low" }));
    expect(generationConfig(body)).toMatchObject({ thinkingConfig: { thinkingLevel: "low" } });
    expect(JSON.stringify(body.systemInstruction)).toContain(GRAPH_SYSTEM_PROMPT.split("\n")[0]);
  });

  it("does not change requests for other models", () => {
    const flash = turn({ model: "gemini-3.8-flash", temperature: 0.2, interactions: interactions({ apiVersion: "v1beta", topP: 0.5, thinkingLevel: "minimal" }) });
    expect(generationConfig(buildInteractionBody(flash))).toMatchObject({ temperature: 0.2, top_p: 0.5, thinking_level: "minimal", max_output_tokens: 8192 });
    expect(generationConfig(buildGenerateContentBody({ ...flash, interactions: undefined }))).toMatchObject({ temperature: 0.2, maxOutputTokens: 8192 });
  });
});

describe("Gemini 4 requests stopped before contacting Google", () => {
  it.each(["europe-west1", "europe-west4", "us-central1"])("rejects the single region %s, which does not serve Gemini 4", async (region) => {
    const provider = vi.fn<typeof fetch>();
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(turn({ provider: "vertex", region }));
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(`Gemini 4 is not served from ${region}. Choose the global endpoint or the us or eu multi-region in Settings.`);
    expect(provider).not.toHaveBeenCalled();
    expect(getVertexAccessToken).not.toHaveBeenCalled();
  });

  it("rejects an explicit context cache, which Gemini 4 does not support", async () => {
    const provider = vi.fn<typeof fetch>();
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(turn({
      provider: "vertex", region: "eu", cachedContent: "projects/project-one/locations/eu/cachedContents/cache_1",
    }));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/does not support explicit context caches/);
    expect(provider).not.toHaveBeenCalled();
  });

  it("still allows a single region for other models", async () => {
    const provider = vi.fn<typeof fetch>().mockResolvedValue(generateContentReply("Hi"));
    const response = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(turn({ provider: "vertex", region: "europe-west1", model: "gemini-3.8-flash" }));
    expect(response.status).toBe(200);
    expect(provider.mock.calls[0]![0]).toContain("https://europe-west1-aiplatform.googleapis.com/");
  });
});
