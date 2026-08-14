// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicConfig } from "../../shared/contracts";
import {
  FALLBACK_SETTINGS,
  conversationTitle,
  createConversation,
  loadConversations,
  loadSettings,
  saveConversations,
  saveSettings,
  settingsForConfig,
} from "./storage";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("crypto", { randomUUID: () => "generated-id" });
});

describe("conversation storage", () => {
  it("creates a version-safe empty conversation when storage is absent", () => {
    const conversations = loadConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0].title).toBe("New conversation");
  });

  it("round-trips JSON conversations", () => {
    const conversation = createConversation();
    conversation.title = "Saved";
    saveConversations([conversation]);
    expect(loadConversations()[0].title).toBe("Saved");
  });

  it("recovers from malformed JSON", () => {
    localStorage.setItem("gemini-prep:conversations:v1", "not-json");
    expect(loadConversations()).toHaveLength(1);
  });

  it("normalizes interrupted streaming messages after reload", () => {
    const conversation = createConversation();
    conversation.messages.push({
      id: "m", role: "assistant", content: "partial", createdAt: new Date().toISOString(), status: "streaming",
    });
    saveConversations([conversation]);
    expect(loadConversations()[0].messages[0].status).toBe("stopped");
  });

  it("creates concise titles from the first message", () => {
    expect(conversationTitle("  hello   world  ")).toBe("hello world");
    expect(conversationTitle("x".repeat(80)).endsWith("…")).toBe(true);
  });
});

describe("settings storage", () => {
  it("round-trips versioned settings", () => {
    saveSettings({ ...FALLBACK_SETTINGS, provider: "gemini" });
    expect(loadSettings().provider).toBe("gemini");
  });

  it("recovers from malformed settings", () => {
    localStorage.setItem("gemini-prep:settings:v1", "{");
    expect(loadSettings()).toEqual(FALLBACK_SETTINGS);
  });

  it("reconciles stale models and regions with server configuration", () => {
    const config = {
      defaults: { provider: "vertex", vertexModel: "v", geminiModel: "g", region: "eu" },
      providers: {
        vertex: { models: [{ id: "v" }] },
        gemini: { models: [{ id: "g" }] },
      },
      regions: [{ id: "eu" }],
    } as PublicConfig;
    const reconciled = settingsForConfig({
      ...FALLBACK_SETTINGS,
      models: { vertex: "old-v", gemini: "old-g" },
      region: "old-region",
    }, config);
    expect(reconciled.models).toEqual({ vertex: "v", gemini: "g" });
    expect(reconciled.region).toBe("eu");
  });
});
