import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import { resolveVertexChatModels } from "../catalog.js";
import { DEFAULT_INTERACTIONS } from "../../shared/interactions.js";
import { buildInteractionBody } from "./interactions.js";
import type { ChatStreamRequest } from "../../shared/contracts.js";

vi.mock("../vertex-auth.js", () => ({ getVertexAccessToken: vi.fn() }));
beforeEach(() => {
  vi.stubEnv("GCP_PROJECT", "project-one");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.mocked(getVertexAccessToken).mockReset().mockResolvedValue("test-adc-token");
});
afterEach(() => vi.unstubAllEnvs());
const body = (extra: Partial<ChatStreamRequest> = {}): ChatStreamRequest => ({
  provider: "vertex", model: resolveVertexChatModels()[0]!.id, region: "global", interactionProject: "project-one",
  interactions: { ...DEFAULT_INTERACTIONS }, temperature: 0.5, maxOutputTokens: 512,
  messages: [{ role: "user", content: "Hello" }], ...extra,
});
const success = () => new Response([
  { event_type: "interaction.created", interaction: { id: "vertex-turn", status: "in_progress" } },
  { event_type: "step.start", index: 0, step: { type: "model_output" } },
  { event_type: "step.delta", index: 0, delta: { type: "text", text: "Hello" } },
  { event_type: "interaction.completed", interaction: { id: "vertex-turn", status: "completed" } },
].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

it("uses project-scoped ADC without a Gemini key, streams text, and saves the server project", async () => {
  const provider = vi.fn<typeof fetch>().mockResolvedValue(success());
  const result = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body());
  expect(result.status).toBe(200);
  expect(provider.mock.calls[0]![0]).toBe("https://aiplatform.googleapis.com/v1beta1/projects/project-one/locations/global/interactions");
  expect(provider.mock.calls[0]![1]?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test-adc-token" });
  expect(result.text).toContain('"interactionProject":"project-one"');
  expect(result.text).toContain('"provider":"vertex"');
  expect(result.text).toContain('"text":"Hello"');
  expect(result.text).not.toContain("test-adc-token");
});

it("continues the same project and checks expired IDs on the same authenticated endpoint", async () => {
  const provider = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{"error":{"message":"Invalid argument"}}', { status: 400 }))
    .mockResolvedValueOnce(new Response("{}", { status: 404 }));
  const result = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ previousInteractionId: "expired" }));
  expect(JSON.parse(String(provider.mock.calls[0]![1]?.body)).previous_interaction_id).toBe("expired");
  expect(provider.mock.calls[1]![0]).toBe("https://aiplatform.googleapis.com/v1beta1/projects/project-one/locations/global/interactions/expired");
  expect(provider.mock.calls[1]![1]?.headers).toHaveProperty("Authorization", "Bearer test-adc-token");
  expect(result.text).toContain('"code":"interaction_reference_invalid"');
});

it.each([
  { interactionProject: "other-project" },
  { previousInteractionId: "old", interactionProject: undefined },
  { region: "us-central1" },
])("rejects project/region mismatches before contacting Google: %j", async (extra) => {
  const provider = vi.fn<typeof fetch>();
  const result = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body(extra));
  expect(result.status).toBe(extra.interactionProject === "other-project" ? 409 : 400);
  expect(provider).not.toHaveBeenCalled();
  expect(getVertexAccessToken).not.toHaveBeenCalled();
});

it("shows missing ADC instead of falling back to an API key", async () => {
  vi.mocked(getVertexAccessToken).mockRejectedValue(new Error("No Google Cloud credentials"));
  vi.stubEnv("GEMINI_API_KEY", "must-not-use");
  const provider = vi.fn<typeof fetch>();
  const result = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body());
  expect(result.status).toBe(500);
  expect(result.body.error).toContain("No Google Cloud credentials");
  expect(provider).not.toHaveBeenCalled();
});

it("maps Vertex sampling, JSON schemas, and image options to the Cloud contract", () => {
  expect(buildInteractionBody(body({ interactions: { ...DEFAULT_INTERACTIONS, topP: 0.9, responseFormat: "json", responseSchema: '{"type":"object"}' } }))).toMatchObject({
    generation_config: { temperature: 0.5, top_p: 0.9 }, response_mime_type: "application/json", response_format: { type: "object" },
  });
  const image = buildInteractionBody(body({ tool: "image", interactions: { ...DEFAULT_INTERACTIONS, imageAspectRatio: "16:9", imageSize: "2K" } }));
  expect(image).toMatchObject({ response_modalities: ["text", "image"], generation_config: { image_config: { aspect_ratio: "16:9", image_size: "2K" } } });
  expect(image).not.toHaveProperty("response_format");
});

it("honors Cloud storage opt-out and does not return a reusable ID", async () => {
  const provider = vi.fn<typeof fetch>().mockResolvedValue(success());
  const result = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ interactions: { ...DEFAULT_INTERACTIONS, store: false, stateful: false } }));
  expect(JSON.parse(String(provider.mock.calls[0]![1]?.body)).store).toBe(false);
  expect(result.text).not.toContain('"interactionId":');
});

it.each([false, true])("accepts a missing terminal ID only when storage is disabled (store=%s)", async (store) => {
  const provider = vi.fn<typeof fetch>().mockResolvedValue(new Response([
    { event_type: "step.start", index: 0, step: { type: "model_output" } },
    { event_type: "step.delta", index: 0, delta: { type: "text", text: '{"code":"CEDAR-73"}' } },
    { event_type: "interaction.completed", interaction: { status: "completed" } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
  const result = await request(createApp({ fetchImpl: provider })).post("/api/chat/stream").send(body({ interactions: { ...DEFAULT_INTERACTIONS, store, stateful: store } }));
  expect(result.text).toContain(store ? "event: error" : "event: done");
  expect(result.text).not.toContain('"interactionId":');
});
