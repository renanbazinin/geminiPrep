// @vitest-environment jsdom
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, ChatMessage, LargeFilesConfig } from "../../shared/contracts";
import { DEFAULT_INTERACTIONS } from "../../shared/interactions";
import { attachmentKind, attachmentToRequestPart, deleteAttachmentPayloads, goesToServer, processAttachment } from "./attachments";
import { selectInteractionHistory } from "./interaction-history";

const limits: LargeFilesConfig = {
  maxUploadBytes: 50 * 1024 * 1024,
  serverThresholdBytes: 1_000,
  pdfInlineMaxBytes: 7 * 1024 * 1024,
  ttlHours: 72,
};

function uploadResponse(id = `doc_${"a".repeat(32)}`) {
  return new Response(JSON.stringify({
    id, name: "x", mimeType: "text/plain", bytes: 5_000, format: "log", lines: 120,
    estimatedTokens: 1_500_000, expiresAt: "2026-12-01T00:00:00.000Z",
  }), { status: 201, headers: { "Content-Type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("large attachment routing", () => {
  it("accepts log files, which often have no MIME type", () => {
    expect(attachmentKind({ name: "server.log", type: "" })).toBe("text");
    expect(attachmentKind({ name: "events.jsonl", type: "" })).toBe("text");
  });

  it("sends large text and PDFs to the server and keeps small ones local", () => {
    expect(goesToServer({ size: 999 }, "text", limits)).toBe(false);
    expect(goesToServer({ size: 1_001 }, "text", limits)).toBe(true);
    expect(goesToServer({ size: 6 * 1024 * 1024 }, "pdf", limits)).toBe(false);
    expect(goesToServer({ size: 8 * 1024 * 1024 }, "pdf", limits)).toBe(true);
  });

  it("uploads a large log as raw bytes and references it by ID", async () => {
    const fetchMock = vi.fn(async () => uploadResponse());
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["2026-01-01 INFO ok\n".repeat(300)], "app.log", { type: "" });
    const attachment = await processAttachment(file, { largeFiles: limits });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/documents");
    expect(init.headers).toMatchObject({ "Content-Type": "application/octet-stream", "X-File-Name": "app.log" });
    expect(init.body).toBe(file);
    expect(attachment.document).toMatchObject({ id: `doc_${"a".repeat(32)}`, format: "log", estimatedTokens: 1_500_000 });
    expect(await attachmentToRequestPart(attachment)).toEqual({ kind: "document", name: "app.log", mimeType: "text/plain", documentId: `doc_${"a".repeat(32)}` });
  });

  it("uploads a small DOCX whose extracted text turns out to be long", async () => {
    const fetchMock = vi.fn(async () => uploadResponse());
    vi.stubGlobal("fetch", fetchMock);
    const archive = new JSZip();
    archive.file("word/document.xml", `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${"long text ".repeat(200)}</w:t></w:r></w:p></w:body></w:document>`);
    const buffer = await archive.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
    const file = new File([buffer], "brief.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    // jsdom's File does not implement arrayBuffer().
    Object.defineProperty(file, "arrayBuffer", { value: async () => buffer });
    expect(file.size).toBeLessThan(limits.serverThresholdBytes);
    const attachment = await processAttachment(file, { largeFiles: limits });
    expect(attachment.document?.id).toBe(`doc_${"a".repeat(32)}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects files over the server upload limit before uploading", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "huge.log");
    Object.defineProperty(file, "size", { value: 60 * 1024 * 1024 });
    await expect(processAttachment(file, { largeFiles: limits })).rejects.toThrow("huge.log is larger than the 50 MB upload limit.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deletes server copies when attachments are discarded", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await deleteAttachmentPayloads([{
      id: "1", storageKey: "server:doc", name: "a.log", mimeType: "text/plain", size: 1, kind: "text",
      document: { id: `doc_${"b".repeat(32)}`, format: "log", lines: 1, estimatedTokens: 1, expiresAt: "" },
    }]);
    expect(fetchMock).toHaveBeenCalledWith(`/api/documents/doc_${"b".repeat(32)}`, { method: "DELETE" });
  });
});

describe("history with large files", () => {
  it("sends the full history instead of continuing a stored interaction", () => {
    const settings = {
      provider: "gemini", geminiApi: "interactions", vertexApi: "generateContent", proModel: false,
      models: { gemini: "gemini-3.8-flash", vertex: "gemini-3.8-flash" },
      interactions: { ...DEFAULT_INTERACTIONS, stateful: true, store: true },
    } as unknown as AppSettings;
    const messages: ChatMessage[] = [
      { id: "u", role: "user", content: "read this", createdAt: "", status: "complete", attachments: [{
        id: "a", storageKey: "server:x", name: "a.log", mimeType: "text/plain", size: 1, kind: "text",
        document: { id: `doc_${"c".repeat(32)}`, format: "log", lines: 1, estimatedTokens: 1, expiresAt: "" },
      }] },
      { id: "m", role: "assistant", content: "ok", createdAt: "", status: "complete",
        request: { provider: "gemini", model: "gemini-3.8-flash" },
        interaction: { id: "int_1", model: "gemini-3.8-flash", apiVersion: "v1" } },
    ];
    expect(selectInteractionHistory(messages, settings, null)).toEqual({ messages, previousInteractionId: undefined });
  });
});
