// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/contracts";
import { selectInteractionHistory } from "./interaction-history";
import { FALLBACK_SETTINGS, loadConversations, loadSettings, saveConversations } from "./storage";

const settings = { ...FALLBACK_SETTINGS, provider: "gemini" as const };
const messages: ChatMessage[] = [
  { id: "u1", role: "user", content: "Remember me", status: "complete", createdAt: "2026-10-08" },
  { id: "a1", role: "assistant", content: "I will", status: "complete", createdAt: "2026-10-08", request: { provider: "gemini", model: settings.models.gemini }, interaction: { id: "remote_1", model: settings.models.gemini, apiVersion: "v1" } },
];
beforeEach(() => localStorage.clear());
describe("conversation continuation", () => {
  it("skips all previously stored content including attachments", () => {
    expect(selectInteractionHistory(messages, settings, null)).toEqual({ messages: [], previousInteractionId: "remote_1" });
  });
  it("retries against the prior successful interaction, keeping the latest user input", () => {
    const retry = [...messages, { ...messages[0], id: "u2", content: "What is my name?" }];
    expect(selectInteractionHistory(retry, settings, null)).toEqual({ messages: [retry[2]], previousInteractionId: "remote_1" });
  });
  it.each(["error", "stopped", "streaming"] as const)("does not reuse a %s turn", (status) => {
    const history = [...messages, { ...messages[1], id: "failed", status }];
    expect(selectInteractionHistory(history, settings, null).previousInteractionId).toBeUndefined();
  });
  it("rebuilds when provider, model, API version, or mode changes", () => {
    for (const other of [
      { ...settings, provider: "vertex" as const },
      { ...settings, models: { ...settings.models, gemini: "another-model" } },
      { ...settings, interactions: { ...settings.interactions, apiVersion: "v1beta" as const } },
      { ...settings, interactions: { ...settings.interactions, stateful: false } },
      { ...settings, geminiApi: "generateContent" as const },
    ]) expect(selectInteractionHistory(messages, other, null).messages).toBe(messages);
    expect(selectInteractionHistory(messages, settings, "image").messages).toBe(messages);
  });
  it("persists reusable IDs across reloads and keeps conversations separate", () => {
    saveConversations([{ id: "chat1", title: "Saved", createdAt: "2026-10-08", updatedAt: "2026-10-08", messages }]);
    expect(selectInteractionHistory(loadConversations()[0].messages, settings, null).previousInteractionId).toBe("remote_1");
    expect(selectInteractionHistory([], settings, null).previousInteractionId).toBeUndefined();
  });
  it("lets the provider determine expiry rather than guessing from a message's age", () => {
    const old = messages.map((message) => ({ ...message, createdAt: "2020-01-01" }));
    expect(selectInteractionHistory(old, settings, null).previousInteractionId).toBe("remote_1");
  });
  it("scopes Cloud continuations to provider, project, and the actual Cloud API version", () => {
    const cloudSettings = { ...settings, provider: "vertex" as const, vertexApi: "interactions" as const };
    const cloudHistory = [messages[0], { ...messages[1], request: { provider: "vertex" as const, model: cloudSettings.models.vertex },
      interaction: { id: "cloud-id", model: cloudSettings.models.vertex, apiVersion: "v1beta1" as const, project: "one" } }];
    expect(selectInteractionHistory(cloudHistory, cloudSettings, null, "one").previousInteractionId).toBe("cloud-id");
    for (const project of ["two", null, undefined]) expect(selectInteractionHistory(cloudHistory, cloudSettings, null, project).messages).toBe(cloudHistory);
    expect(selectInteractionHistory(cloudHistory, settings, null, "one").messages).toBe(cloudHistory);
    expect(selectInteractionHistory(messages, cloudSettings, null, "one").messages).toBe(messages);
    const missingProject = [messages[0], { ...cloudHistory[1], interaction: { ...cloudHistory[1].interaction!, project: undefined } }];
    expect(selectInteractionHistory(missingProject, cloudSettings, null, "one").messages).toBe(missingProject);
  });
  it.each(["", " ", "bad id", "bad\nreference", "x".repeat(4097)])("rebuilds instead of sending a malformed stored reference", (id) => {
    const history = [messages[0], { ...messages[1], interaction: { ...messages[1].interaction!, id } }];
    expect(selectInteractionHistory(history, settings, null)).toEqual({ messages: history });
  });
  it("migrates existing settings without replacing the user's provider or model", () => {
    localStorage.setItem("gemini-prep:settings:v1", JSON.stringify({ version: 1, provider: "vertex", models: { vertex: "saved-model" }, temperature: 0.5 }));
    expect(loadSettings()).toMatchObject({ provider: "vertex", models: { vertex: "saved-model" }, temperature: 0.5, geminiApi: "interactions", interactions: { stateful: true, store: true } });
  });
  it("preserves storage opt-out and unfinished schema drafts across reloads", () => {
    const saved = { ...settings, interactions: { ...settings.interactions, store: false, stateful: false, responseFormat: "json", responseSchema: "{" } };
    localStorage.setItem("gemini-prep:settings:v1", JSON.stringify(saved));
    expect(loadSettings().interactions).toMatchObject({ store: false, stateful: false, responseSchema: "{" });
    localStorage.setItem("gemini-prep:settings:v1", JSON.stringify({ ...saved, interactions: { ...saved.interactions, seed: "broken" } }));
    expect(loadSettings().interactions).toMatchObject({ store: false, stateful: false });
  });
});
