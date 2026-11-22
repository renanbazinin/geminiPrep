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
import { effectiveLargeFilesLimits, requestInlineTokens } from "./large-files-limits";

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

  it("round-trips large-file thresholds, keeping null as the server's value", () => {
    saveSettings({ ...FALLBACK_SETTINGS, largeFiles: { serverThresholdKb: 4096, pdfInlineMaxMb: 0, inlineTokens: null } });
    expect(loadSettings().largeFiles).toEqual({ serverThresholdKb: 4096, pdfInlineMaxMb: 0, inlineTokens: null });
    expect(FALLBACK_SETTINGS.largeFiles).toBeUndefined();
  });

  it("drops large-file thresholds that are not usable numbers", () => {
    const save = (largeFiles: unknown) => localStorage.setItem("gemini-prep:settings:v1", JSON.stringify({ ...FALLBACK_SETTINGS, largeFiles }));
    save({ serverThresholdKb: -1, pdfInlineMaxMb: "4", inlineTokens: 50_000, other: 3 });
    expect(loadSettings().largeFiles).toEqual({ inlineTokens: 50_000 });
    save({ serverThresholdKb: -1, pdfInlineMaxMb: true });
    expect(loadSettings()).not.toHaveProperty("largeFiles");
    save("lots");
    expect(loadSettings()).not.toHaveProperty("largeFiles");
    // JSON has no Infinity or NaN: they are saved as null, which is the server's value again.
    saveSettings({ ...FALLBACK_SETTINGS, largeFiles: { serverThresholdKb: Number.POSITIVE_INFINITY, inlineTokens: Number.NaN } });
    expect(loadSettings().largeFiles).toEqual({ serverThresholdKb: null, inlineTokens: null });
  });

  it("keeps large-file thresholds as saved, so a server whose limits dip for a while does not lower them for good", () => {
    const configWith = (inlineTokens: number, pdfMb: number) => ({
      defaults: { provider: "gemini", vertexModel: "v", geminiModel: "g", region: "global" },
      providers: { vertex: { models: [{ id: "v" }] }, gemini: { models: [{ id: "g" }] } },
      regions: [{ id: "global" }],
      largeFiles: {
        maxUploadBytes: 10 * 1024 * 1024,
        serverThresholdBytes: 512 * 1024,
        inlineTokens,
        pdfInlineMaxBytes: pdfMb * 1024 * 1024,
        ttlHours: 72,
        engine: "npm",
      },
    }) as PublicConfig;
    const settings = { ...FALLBACK_SETTINGS, models: { vertex: "v", gemini: "g" } };
    const high = configWith(200_000, 7);
    const low = configWith(100_000, 5);

    // Values outside the server's bounds are not rewritten; they are clamped where they are used.
    const outside = { serverThresholdKb: 50_000, pdfInlineMaxMb: 20, inlineTokens: 10 };
    expect(settingsForConfig({ ...settings, largeFiles: outside }, high).largeFiles).toEqual(outside);
    expect(effectiveLargeFilesLimits(high.largeFiles!, outside)).toMatchObject({
      serverThresholdBytes: 10 * 1024 * 1024, pdfInlineMaxBytes: 7 * 1024 * 1024, inlineTokens: 1_000,
    });
    expect(settingsForConfig(settings, high)).not.toHaveProperty("largeFiles");

    // The settings are saved after every config fetch (AppContext): a dip in the server's limits
    // leaves the saved values alone, so they apply again once the server goes back up.
    saveSettings({ ...settings, largeFiles: { inlineTokens: 150_000, pdfInlineMaxMb: 6 } });
    saveSettings(settingsForConfig(loadSettings(), low));
    expect(requestInlineTokens(low.largeFiles, loadSettings().largeFiles)).toBeUndefined();
    expect(effectiveLargeFilesLimits(low.largeFiles!, loadSettings().largeFiles).pdfInlineMaxBytes).toBe(5 * 1024 * 1024);
    const restored = settingsForConfig(loadSettings(), high);
    expect(restored.largeFiles).toEqual({ inlineTokens: 150_000, pdfInlineMaxMb: 6 });
    expect(requestInlineTokens(high.largeFiles, restored.largeFiles)).toBe(150_000);
    expect(effectiveLargeFilesLimits(high.largeFiles!, restored.largeFiles).pdfInlineMaxBytes).toBe(6 * 1024 * 1024);

    // An older server sends no limits: the thresholds stay as saved too.
    const { largeFiles: _absent, ...olderServer } = high;
    expect(settingsForConfig({ ...settings, largeFiles: { inlineTokens: 10 } }, olderServer).largeFiles).toEqual({ inlineTokens: 10 });
  });
});
