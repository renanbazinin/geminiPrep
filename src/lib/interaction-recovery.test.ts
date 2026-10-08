import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamRequest } from "../../shared/contracts";
import { DEFAULT_INTERACTIONS } from "../../shared/interactions";
import { streamChatWithRecovery } from "./interaction-recovery";

const request: ChatStreamRequest = { provider: "gemini", model: "gemini-test", temperature: 1, maxOutputTokens: 100,
  interactions: { ...DEFAULT_INTERACTIONS }, previousInteractionId: "expired", messages: [{ role: "user", content: "Follow up" }] };
const rejected = { event: "error", data: { message: "Previous interaction ID expired", status: 400, code: "interaction_reference_invalid" } };
const done = { event: "done", data: { interactionId: "new", interactionStatus: "completed" } };
const delta = { event: "delta", data: { text: "Answer" } };
function response(...events: unknown[]) {
  return new Response(events.map((event) => {
    const entry = event as { event: string; data: unknown };
    return `event: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;
  }).join(""));
}
function setup() {
  const messages: ChatStreamRequest["messages"] = [{ role: "user", content: "Original question", files: [{ kind: "text", name: "notes.txt", mimeType: "text/plain", text: "Original file" }] }, { role: "assistant", content: "Original answer" }, ...request.messages];
  return { rebuildMessages: vi.fn(async () => messages), onRecover: vi.fn(), onRebuilt: vi.fn() };
}
afterEach(() => vi.unstubAllGlobals());
describe("bounded interaction recovery", () => {
  it("loads complete local history only on rejection, sends no stale ID, and reports recovery", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(rejected)).mockResolvedValueOnce(response(delta, done));
    vi.stubGlobal("fetch", fetchMock);
    const recovery = setup();
    const onError = vi.fn();
    await streamChatWithRecovery(request, { onDelta() {}, onError }, new AbortController().signal, recovery);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(sent).not.toHaveProperty("previousInteractionId");
    expect(sent.messages).toHaveLength(3);
    expect(sent.messages[0].files[0].text).toBe("Original file");
    expect(sent.interactions).toEqual(DEFAULT_INTERACTIONS);
    expect(recovery.onRecover).toHaveBeenCalledOnce();
    expect(recovery.onRebuilt).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });
  it("does not load older attachments when continuation succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(done)));
    const recovery = setup();
    await streamChatWithRecovery(request, { onDelta() {} }, new AbortController().signal, recovery);
    expect(recovery.rebuildMessages).not.toHaveBeenCalled();
  });
  it.each([401, 403, 429, 500, 503])("does not replay HTTP %s even if a reference error is claimed", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(response({ ...rejected, data: { ...rejected.data, status } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(streamChatWithRecovery(request, { onDelta() {} }, new AbortController().signal, setup())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not mistake model-not-found or generic 400s for reference expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ event: "error", data: { status: 404, message: "Model not found" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(streamChatWithRecovery(request, { onDelta() {} }, new AbortController().signal, setup())).rejects.toThrow("Model not found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never loops if the second request also fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(rejected));
    vi.stubGlobal("fetch", fetchMock);
    await expect(streamChatWithRecovery(request, { onDelta() {} }, new AbortController().signal, setup())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([delta, { event: "thinking", data: { text: "summary" } }, { event: "image", data: { mimeType: "image/png", data: "YQ==" } }])("does not replay after generation starts: %j", async (event) => {
    const fetchMock = vi.fn().mockResolvedValue(response(event, rejected));
    vi.stubGlobal("fetch", fetchMock);
    await expect(streamChatWithRecovery(request, { onDelta() {} }, new AbortController().signal, setup())).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("stops when an attachment is missing and does not send a partial history", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(rejected));
    vi.stubGlobal("fetch", fetchMock);
    const recovery = setup();
    recovery.rebuildMessages.mockRejectedValue(new Error("report.pdf is missing"));
    await expect(streamChatWithRecovery(request, { onDelta() {} }, new AbortController().signal, recovery)).rejects.toThrow(/report.pdf is missing.*no history was silently omitted/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("respects cancellation during the local history rebuild", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(response(rejected));
    vi.stubGlobal("fetch", fetchMock);
    const recovery = setup();
    recovery.rebuildMessages.mockImplementation(async () => { controller.abort(); return []; });
    await expect(streamChatWithRecovery(request, { onDelta() {} }, controller.signal, recovery)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not retry network failures or truncated streams", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("Network disconnected")).mockResolvedValueOnce(response(delta));
    vi.stubGlobal("fetch", fetchMock);
    const recovery = setup();
    await expect(streamChatWithRecovery(request, { onDelta() {} }, new AbortController().signal, recovery)).rejects.toThrow("Network disconnected");
    await expect(streamChatWithRecovery(request, { onDelta() {} }, new AbortController().signal, recovery)).rejects.toThrow("before the model completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recovery.rebuildMessages).not.toHaveBeenCalled();
  });
});
