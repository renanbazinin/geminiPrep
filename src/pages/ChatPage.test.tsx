// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ChatStreamRequest, PublicConfig } from "../../shared/contracts";
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
