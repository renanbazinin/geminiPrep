// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ChatMessage, ChatStreamRequest, PublicConfig } from "../../shared/contracts";
import { AppProvider } from "../contexts/AppContext";
import { ConfigProvider } from "../contexts/ConfigContext";
import { FALLBACK_SETTINGS } from "../lib/storage";
import { ChatPage } from "./ChatPage";

vi.mock("../components/MarkdownMessage", () => ({ MarkdownMessage: ({ children }: { children: string }) => <p>{children}</p> }));
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

it.each(["gemini", "vertex"] as const)("%s continues after reload, retries, recovers a rejected ID once, and persists the replacement", async (provider) => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("gemini-prep:settings:v1", JSON.stringify({ ...FALLBACK_SETTINGS, provider, vertexApi: "interactions", region: "us-central1" }));
  const model = FALLBACK_SETTINGS.models.gemini;
  const config: PublicConfig = {
    appName: "Test", project: "project-one", regions: [{ id: "global", label: "Global", group: "global" }, { id: "us-central1", label: "US Central", group: "us" }],
    defaults: { provider: "gemini", vertexModel: model, geminiModel: model, region: "global" },
    providers: {
      vertex: { id: "vertex", label: "Vertex", ready: true, status: "Ready", models: [{ id: model, label: "Flash", family: "3.x" }] },
      gemini: { id: "gemini", label: "Gemini", ready: true, status: "Ready", models: [{ id: model, label: "Flash", family: "3.x" }] },
    },
  };
  const calls: ChatStreamRequest[] = [];
  let rejectNext = false;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return new Response(JSON.stringify(config));
    expect(url).toBe("/api/chat/stream");
    calls.push(JSON.parse(String(init?.body)) as ChatStreamRequest);
    const id = calls.length;
    if (rejectNext) {
      rejectNext = false;
      return new Response('event: error\ndata: {"message":"Expired interaction","status":404,"code":"interaction_reference_invalid"}\n\n');
    }
    return new Response(`event: delta\ndata: ${JSON.stringify({ text: `Answer ${id}` })}\n\nevent: done\ndata: ${JSON.stringify({ interactionId: `remote_${id}`, interactionStatus: "completed", ...(provider === "vertex" ? { interactionProject: "project-one" } : {}) })}\n\n`);
  }));
  const mount = () => render(<MemoryRouter><AppProvider><ConfigProvider><ChatPage /></ConfigProvider></AppProvider></MemoryRouter>);
  const send = async (text: string, answer: number) => {
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: text } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText(`Answer ${answer}`, { exact: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Stop generating" })).not.toBeInTheDocument());
  };
  mount();
  await send("Remember my name", 1);
  await send("What did I say?", 2);
  expect(calls[1]).toMatchObject({ previousInteractionId: "remote_1", messages: [{ role: "user", content: "What did I say?" }] });
  expect(calls[1].messages).toHaveLength(1);
  if (provider === "vertex") expect(calls[1]).toMatchObject({ provider, region: "global", interactionProject: "project-one" });
  cleanup();
  mount();
  await send("Still remember?", 3);
  expect(calls[2].previousInteractionId).toBe("remote_2");
  fireEvent.click(screen.getByRole("button", { name: "Retry response" }));
  await screen.findByText("Answer 4", { exact: true });
  expect(calls[3]).toMatchObject({ previousInteractionId: "remote_2", messages: [{ role: "user", content: "Still remember?" }] });
  rejectNext = true;
  await send("Restore the chat", 6);
  expect(calls[4].previousInteractionId).toBe("remote_4");
  expect(calls[5].previousInteractionId).toBeUndefined();
  expect(calls[5].messages.map((message) => message.content)).toEqual([
    "Remember my name", "Answer 1", "What did I say?", "Answer 2", "Still remember?", "Answer 4", "Restore the chat",
  ]);
  expect(screen.getByText("Conversation restored from local history.")).toBeInTheDocument();
  const stored = JSON.parse(localStorage.getItem("gemini-prep:conversations:v1")!);
  expect(stored[0].messages.filter((message: { interaction?: unknown }) => message.interaction)).toHaveLength(1);
  expect(stored[0].messages.at(-1).interaction.id).toBe("remote_6");
  cleanup();
  mount();
  await send("After recovery", 7);
  expect(calls[6].previousInteractionId).toBe("remote_6");
  await waitFor(() => expect(screen.getByRole("button", { name: "Reconnect from local history" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Reconnect from local history" }));
  await send("Reconnected", 8);
  expect(calls[7].previousInteractionId).toBeUndefined();
  expect(calls[7].messages).toHaveLength(11);
  expect(calls[7].messages[0].content).toBe("Remember my name");
}, 15_000);

function largeFilesConfig(): PublicConfig {
  const model = FALLBACK_SETTINGS.models.gemini;
  return {
    appName: "Test", project: null, regions: [{ id: "global", label: "Global", group: "global" }],
    defaults: { provider: "gemini", vertexModel: model, geminiModel: model, region: "global" },
    providers: {
      vertex: { id: "vertex", label: "Vertex", ready: true, status: "Ready", models: [{ id: model, label: "Flash", family: "3.x" }] },
      gemini: { id: "gemini", label: "Gemini", ready: true, status: "Ready", models: [{ id: model, label: "Flash", family: "3.x" }] },
    },
    largeFiles: {
      maxUploadBytes: 100 * 1024 * 1024, serverThresholdBytes: 512 * 1024, inlineTokens: 200_000,
      pdfInlineMaxBytes: 7 * 1024 * 1024, ttlHours: 72, engine: "npm",
    },
  };
}

const mountChat = () => render(<MemoryRouter><AppProvider><ConfigProvider><ChatPage /></ConfigProvider></AppProvider></MemoryRouter>);

it("sends the user's lower token threshold and shows the large-file tool calls, notes and totals of an answer", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("gemini-prep:settings:v1", JSON.stringify({ ...FALLBACK_SETTINGS, provider: "gemini", geminiApi: "generateContent", largeFiles: { inlineTokens: 50_000 } }));
  const event = (data: Record<string, unknown>, seq: number) => `event: largeFiles\ndata: ${JSON.stringify({ ...data, seq, runId: "run_1", time: seq })}\n\n`;
  const usage = { requests: 3, inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 120, thoughtTokens: 0,
    byModel: { "gemini-3.8-flash": { requests: 3, inputTokens: 9_000, cachedInputTokens: 0, outputTokens: 120, thoughtTokens: 0 } } };
  const calls: ChatStreamRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return new Response(JSON.stringify(largeFilesConfig()));
    calls.push(JSON.parse(String(init?.body)) as ChatStreamRequest);
    return new Response([
      event({ type: "run.start", models: { answer: "gemini-3.8-flash" }, documentIds: [] }, 1),
      "event: activity\ndata: {\"text\":\"Read all of app.log…\"}\n\n",
      event({ type: "tool.start", callId: "call_1", tool: "analyze_whole_document", args: {}, label: "Read all of app.log", round: 1 }, 2),
      event({ type: "request.start", requestId: "req_2", role: "reader", purpose: "part", model: "gemini-3.8-flash", callId: "call_1" }, 3),
      event({ type: "retry", requestId: "req_2", attempt: 1, delayMs: 10, error: { message: "busy" }, message: "" }, 4),
      event({ type: "tool.progress", callId: "call_1", stage: "map", done: 1, total: 2, message: "Reading app.log: part 1 of 2" }, 5),
      event({ type: "tool.progress", callId: "call_1", stage: "map", done: 2, total: 2, message: "Reading app.log: part 2 of 2" }, 6),
      event({ type: "tool.end", callId: "call_1", outcome: "ok", ms: 2_400, step: "Read all of app.log — 2 parts read",
        evidence: { tool: "analyze_whole_document", documentId: "doc_1", whole: true, callId: "call_1" } }, 7),
      "event: step\ndata: {\"text\":\"Read all of app.log — 2 parts read\"}\n\n",
      event({ type: "notice", code: "budget_reached", message: "No more tools: the question reached its limit of input tokens or requests.", display: "none" }, 8),
      "event: delta\ndata: {\"text\":\"Two timeouts.\"}\n\n",
      event({ type: "run.finish", result: { answered: true, finishReason: "STOP", steps: ["Read all of app.log — 2 parts read"], evidence: [], turns: 2, usage } }, 9),
      "event: done\ndata: {\"finishReason\":\"STOP\"}\n\n",
    ].join(""));
  }));
  mountChat();
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "How many timeouts?" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Two timeouts.");
  expect(calls[0].largeFilesInlineTokens).toBe(50_000);
  // The tool list takes the place of the plain steps.
  expect(screen.getByText("Steps on large files (1)")).toBeInTheDocument();
  const list = screen.getByRole("list", { name: "Tool calls on large files" });
  expect(within(list).getByText("Read all of app.log")).toBeInTheDocument();
  expect(within(list).getByText("— 2 parts read")).toBeInTheDocument();
  expect(within(list).getByText("retried 1×")).toBeInTheDocument();
  // The read ended: its bar is gone, and the step says how it went.
  expect(within(list).queryByRole("progressbar")).not.toBeInTheDocument();
  expect(within(list).getByText("Shown: the whole file")).toBeInTheDocument();
  expect(screen.getByRole("list", { name: "Notes on large files" })).toHaveTextContent("No more tools");
  fireEvent.click(screen.getByText("Debug trace"));
  expect(screen.getByText("Large files · whole question")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop generating" })).not.toBeInTheDocument());
  const stored = JSON.parse(localStorage.getItem("gemini-prep:conversations:v1")!) as Array<{ messages: ChatMessage[] }>;
  const answer = stored.flatMap((conversation) => conversation.messages).at(-1)!;
  expect(answer).toMatchObject({ steps: ["Read all of app.log — 2 parts read"], largeFileUsage: usage });
  expect(answer.largeFileCalls).toHaveLength(1);
  // The debug trace keeps the library's events, with only the latest progress of a call.
  const types = answer.debug!.response.events!.flatMap((entry) => (entry.event === "largeFiles" ? [entry.data.type] : []));
  expect(types).toEqual(["run.start", "tool.start", "request.start", "retry", "tool.progress", "tool.end", "notice", "run.finish"]);
});

it("leaves the token threshold to the server when the user has not lowered it", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("gemini-prep:settings:v1", JSON.stringify({ ...FALLBACK_SETTINGS, provider: "gemini", geminiApi: "generateContent" }));
  const calls: ChatStreamRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return new Response(JSON.stringify(largeFilesConfig()));
    calls.push(JSON.parse(String(init?.body)) as ChatStreamRequest);
    return new Response("event: delta\ndata: {\"text\":\"Hello\"}\n\nevent: done\ndata: {}\n\n");
  }));
  mountChat();
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Hi" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Hello");
  expect(calls[0]).not.toHaveProperty("largeFilesInlineTokens");
});

it("shows each file's upload progress, then how the server read it", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  // The user uploads text above 1 KB, below the server's 512 KB.
  localStorage.setItem("gemini-prep:settings:v1", JSON.stringify({ ...FALLBACK_SETTINGS, provider: "gemini", largeFiles: { serverThresholdKb: 1 } }));
  const encoder = new TextEncoder();
  let upload!: ReadableStreamDefaultController<Uint8Array>;
  const send = (data: Record<string, unknown>) => upload.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url === "/api/config") return new Response(JSON.stringify(largeFilesConfig()));
    expect(url).toBe("/api/documents");
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { upload = controller; } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  mountChat();
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose files" })).toBeEnabled());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/config", expect.anything()));
  const file = new File(["a;b\n".repeat(600)], "notes.csv", { type: "text/csv" });
  fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/documents", expect.objectContaining({ method: "POST" })));
  send({ type: "ingest.start", name: "notes.csv", format: "csv", bytes: file.size, seq: 1 });
  send({ type: "ingest.progress", stage: "prepare", done: 600, total: 2_400, unit: "characters", seq: 2 });
  const counts = await screen.findByText("notes.csv — preparing the text (25%)…");
  // The live region tells the file and the stage only; the counts beside it are not announced.
  const status = within(screen.getByLabelText("Files ready to attach")).getByRole("status");
  expect(status).toHaveTextContent(/^notes\.csv — preparing the text$/);
  expect(counts.closest("[role=status], [aria-live]")).toBeNull();
  send({ type: "ingest.progress", stage: "prepare", done: 1_800, total: 2_400, unit: "characters", seq: 3 });
  expect(await screen.findByText("notes.csv — preparing the text (75%)…")).toBeInTheDocument();
  expect(status).toHaveTextContent(/^notes\.csv — preparing the text$/);
  send({ type: "ingest.finish", seq: 3, document: {
    id: `doc_${"e".repeat(32)}`, name: "notes.csv", mimeType: "text/csv", format: "csv", bytes: file.size, lines: 600,
    estimatedTokens: 1_200, expiresAt: "2026-12-01T00:00:00.000Z", encoding: "windows-1255", replacedCharacters: 3,
  } });
  upload.close();
  expect(await screen.findByText("CSV · 2.3 KB · ~1K tokens · on server · read as windows-1255 · 3 unreadable characters")).toBeInTheDocument();
  expect(screen.queryByText(/preparing the text/)).not.toBeInTheDocument();
});

/** Enough of IndexedDB for files kept in this browser: what is stored, by key. */
function fakeIndexedDb(store: Map<string, unknown>) {
  const database = {
    objectStoreNames: { contains: () => true },
    transaction() {
      const transaction: { objectStore: () => unknown; oncomplete?: () => void } = {
        objectStore: () => ({
          put(value: unknown, key?: string) { store.set(key ?? String((value as { key?: string }).key), value); },
          delete(key: string) { store.delete(key); },
        }),
      };
      queueMicrotask(() => transaction.oncomplete?.());
      return transaction;
    },
  };
  return {
    open() {
      const request: { result: typeof database; onsuccess?: () => void } = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
}

it("counts toward the 20 MB kept in this browser only the files that stay here, once their text is read", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  // The highest text threshold: a file of 11 MB is judged by its text, not by its size.
  localStorage.setItem("gemini-prep:settings:v1", JSON.stringify({ ...FALLBACK_SETTINGS, provider: "gemini", largeFiles: { serverThresholdKb: 20_480 } }));
  const stored = new Map<string, unknown>();
  vi.stubGlobal("indexedDB", fakeIndexedDb(stored));
  let uploads = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/config") return new Response(JSON.stringify(largeFilesConfig()));
    if (url.startsWith("/api/documents/")) return new Response(null, { status: 204 });
    expect(url).toBe("/api/documents");
    uploads += 1;
    return new Response(JSON.stringify({
      id: `doc_${String(uploads).repeat(32)}`, name: "app.log", mimeType: "text/plain", format: "log", bytes: 11 * 1024 * 1024, lines: 1_000_000,
      estimatedTokens: 3_000_000, expiresAt: "2026-12-01T00:00:00.000Z",
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  mountChat();
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose files" })).toBeEnabled());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/config", expect.anything()));
  const size = 11 * 1024 * 1024;
  // Dense text: millions of tokens, so it is uploaded. Space-padded text: few tokens, so it stays here.
  // jsdom's File has no text().
  const textFile = (content: string, name: string) => Object.assign(new File([content], name, { type: "text/plain" }), { text: async () => content });
  const dense = (name: string) => textFile("timeout 42\n".repeat(Math.ceil(size / 11)).slice(0, size), name);
  const sparse = (name: string) => textFile(`total 1${" ".repeat(size - 9)}\n`, name);
  const attach = (files: File[]) => fireEvent.change(screen.getByLabelText("Attach files"), { target: { files } });
  const pending = () => screen.getByLabelText("Files ready to attach");

  // 22 MB under the threshold, but the log goes to the server: 11 MB stays here.
  attach([dense("app.log"), sparse("report.txt")]);
  await waitFor(() => expect(within(pending()).getByRole("button", { name: "Remove report.txt" })).toBeInTheDocument(), { timeout: 10_000 });
  expect(within(pending()).getByRole("button", { name: "Remove app.log" })).toBeInTheDocument();
  expect(screen.queryByText(/cannot exceed 20 MB combined/)).not.toBeInTheDocument();
  expect(uploads).toBe(1);
  expect(stored.size).toBe(1);

  // Another 11 MB that stays here makes 22 MB: refused once its text is read, and its stored copy removed.
  attach([sparse("second.txt")]);
  expect(await screen.findByText("Attachments kept in this browser cannot exceed 20 MB combined.", {}, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove second.txt" })).not.toBeInTheDocument();
  expect(within(pending()).getByRole("button", { name: "Remove report.txt" })).toBeInTheDocument();
  await waitFor(() => expect(stored.size).toBe(1));
}, 30_000);
