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

  it("persists assistant debug traces with the conversation", () => {
    const conversation = createConversation();
    conversation.messages.push({
      id: "assistant-debug",
      role: "assistant",
      content: "done",
      createdAt: "2026-08-14T00:00:00.000Z",
      status: "complete",
      debug: {
        version: 1,
        request: { local: { method: "POST", url: "/api/chat/stream", headers: {}, body: { messages: [] } } },
        response: { status: "complete", content: "done", deltaEvents: 1, receivedCharacters: 4 },
        timing: { clientStartedAt: "2026-08-14T00:00:00.000Z", clientDurationMs: 100 },
      },
    });
    saveConversations([conversation]);
    expect(loadConversations()[0].messages[0].debug?.timing.clientDurationMs).toBe(100);
  });

  it("persists attachment metadata without embedding file payloads", () => {
    const conversation = createConversation();
    conversation.messages.push({
      id: "user-files",
      role: "user",
      content: "Review these files",
      createdAt: "2026-08-14T00:00:00.000Z",
      status: "complete",
      attachments: [{
        id: "file-1",
        storageKey: "attachment:file-1",
        name: "notes.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 4096,
        kind: "docx",
        extractedCharacters: 120,
      }],
    });

    saveConversations([conversation]);

    expect(loadConversations()[0].messages[0].attachments?.[0]).toMatchObject({
      name: "notes.docx",
      storageKey: "attachment:file-1",
      extractedCharacters: 120,
    });
    expect(localStorage.getItem("gemini-prep:conversations:v1")).not.toContain("PK");
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
