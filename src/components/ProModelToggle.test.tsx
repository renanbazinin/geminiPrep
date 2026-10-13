// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AppSettings, ChatStreamRequest, PublicConfig } from "../../shared/contracts";
import { PRO_MODEL } from "../../shared/gemini-4";
import { AppProvider } from "../contexts/AppContext";
import { ConfigProvider } from "../contexts/ConfigContext";
import { FALLBACK_SETTINGS, loadSettings } from "../lib/storage";
import { ChatPage } from "../pages/ChatPage";
import { SettingsPage } from "../pages/SettingsPage";

vi.mock("./MarkdownMessage", () => ({ MarkdownMessage: ({ children }: { children: string }) => <p>{children}</p> }));

const SETTINGS_KEY = "gemini-prep:settings:v1";
const FLASH = { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", family: "3.x" };

function serverConfig(models = [FLASH, PRO_MODEL]): PublicConfig {
  return {
    appName: "Test", project: "project-one",
    regions: [
      { id: "global", label: "Global", group: "global" },
      { id: "eu", label: "EU multi-region", group: "eu" },
      { id: "europe-west1", label: "Belgium", group: "eu" },
    ],
    defaults: { provider: "gemini", vertexModel: FLASH.id, geminiModel: FLASH.id, region: "global" },
    providers: {
      vertex: { id: "vertex", label: "Vertex", ready: true, status: "Ready", models },
      gemini: { id: "gemini", label: "Gemini", ready: true, status: "Ready", models },
    },
  };
}
const saveSettings = (patch: Partial<AppSettings>) => localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...FALLBACK_SETTINGS, ...patch }));
const savedSettings = (): AppSettings => JSON.parse(localStorage.getItem(SETTINGS_KEY)!) as AppSettings;

/** Answers every chat turn and records what the browser sent, like the real /api/chat/stream. */
function stubServer(config = serverConfig()) {
  const sent: ChatStreamRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/config") return new Response(JSON.stringify(config));
    const request = JSON.parse(String(init?.body)) as ChatStreamRequest;
    sent.push(request);
    const n = sent.length;
    return new Response(`event: delta\ndata: ${JSON.stringify({ text: `Answer ${n} from ${request.model}` })}\n\n`
      + `event: done\ndata: ${JSON.stringify({ interactionId: `remote_${n}`, interactionStatus: "completed" })}\n\n`);
  }));
  return sent;
}

function renderPage(page: "chat" | "settings") {
  return render(<MemoryRouter><AppProvider><ConfigProvider>{page === "chat" ? <ChatPage /> : <SettingsPage />}</ConfigProvider></AppProvider></MemoryRouter>);
}
async function proSwitch() {
  const toggle = await screen.findByRole("switch", { name: "Gemini 4 Pro model" });
  await waitFor(() => expect(toggle).toBeEnabled());
  return toggle;
}
async function send(text: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: text } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop generating" })).not.toBeInTheDocument());
}

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn(); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("Gemini 4 toggle in chat", () => {
  it("is off by default and labelled Gemini 4 Pro", async () => {
    stubServer();
    renderPage("chat");
    const toggle = await proSwitch();
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveTextContent("Gemini 4");
    expect(toggle).toHaveTextContent("Pro");
  });

  it("sends the next message to Gemini 4 and switches back to the saved model when turned off", async () => {
    const sent = stubServer();
    renderPage("chat");
    const toggle = await proSwitch();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTitle("Open model settings")).toHaveTextContent(PRO_MODEL.id);
    await send("Plan a hard migration");
    expect(sent[0]!.model).toBe(PRO_MODEL.id);
    expect(await screen.findByText(`Answer 1 from ${PRO_MODEL.id}`)).toBeInTheDocument();

    fireEvent.click(toggle);
    await send("Now a quick one");
    expect(sent[1]!.model).toBe(FLASH.id);
    // The toggle never overwrites the model chosen in Settings.
    expect(savedSettings()).toMatchObject({ proModel: false, models: { gemini: FLASH.id } });
  });

  it("keeps a separate conversation chain per model, rebuilding from local history on each switch", async () => {
    const sent = stubServer();
    renderPage("chat");
    const toggle = await proSwitch();

    await send("My name is Dana");
    await send("And I live in Haifa");
    expect(sent[1]!.previousInteractionId).toBe("remote_1");

    fireEvent.click(toggle);
    await send("What do you know about me?");
    expect(sent[2]).toMatchObject({ model: PRO_MODEL.id });
    expect(sent[2]!.previousInteractionId).toBeUndefined();
    expect(sent[2]!.messages.map((message) => message.content)).toEqual([
      "My name is Dana", `Answer 1 from ${FLASH.id}`, "And I live in Haifa", `Answer 2 from ${FLASH.id}`, "What do you know about me?",
    ]);

    await send("Thanks");
    expect(sent[3]).toMatchObject({ model: PRO_MODEL.id, previousInteractionId: "remote_3" });
    expect(sent[3]!.messages).toHaveLength(1);
  });

  it("survives a reload", async () => {
    stubServer();
    renderPage("chat");
    fireEvent.click(await proSwitch());
    cleanup();
    renderPage("chat");
    expect(await proSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("is disabled, and a saved 'on' is turned off, when the server does not offer Gemini 4", async () => {
    saveSettings({ proModel: true });
    stubServer(serverConfig([FLASH]));
    renderPage("chat");
    const toggle = await screen.findByRole("switch", { name: "Gemini 4 Pro model" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", "Gemini 4 is not available from this server");
  });

  it("warns before sending when Vertex Generate Content points at a region without Gemini 4", async () => {
    saveSettings({ provider: "vertex", vertexApi: "generateContent", region: "europe-west1", proModel: true });
    stubServer();
    renderPage("chat");
    expect(await screen.findByRole("alert")).toHaveTextContent("Gemini 4 is not served from europe-west1.");
  });

  it("does not warn for the EU multi-region, which serves Gemini 4", async () => {
    saveSettings({ provider: "vertex", vertexApi: "generateContent", region: "eu", proModel: true });
    stubServer();
    renderPage("chat");
    await proSwitch();
    expect(screen.queryByText(/is not served from/)).not.toBeInTheDocument();
  });
});

describe("Gemini 4 in Settings", () => {
  it("mirrors the chat toggle and locks the model menu while on", async () => {
    stubServer();
    renderPage("settings");
    const checkbox = await screen.findByRole("checkbox", { name: /Use Gemini 4 \(Pro model\)/ });
    await waitFor(() => expect(checkbox).toBeEnabled());
    const modelMenu = screen.getByRole("combobox", { name: /^Model/ });
    expect(within(modelMenu).queryByRole("option", { name: new RegExp(PRO_MODEL.id) })).not.toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(savedSettings().proModel).toBe(true);
    expect(modelMenu).toBeDisabled();
    expect(screen.getByText("Gemini 4 is on. Turn it off to use this model again.")).toBeInTheDocument();
    expect(screen.getByRole("slider")).toBeDisabled();
    expect(screen.getByText("Gemini 4 manages its own sampling; temperature is not sent.")).toBeInTheDocument();
    expect(screen.getByText("Gemini 4 raises this to 32,768 so thinking leaves room for the answer.")).toBeInTheDocument();
  });

  it("disables minimal thinking and Top P for Gemini 4 Interactions", async () => {
    saveSettings({ geminiApi: "interactions", proModel: true, interactions: { ...FALLBACK_SETTINGS.interactions, apiVersion: "v1beta" } });
    stubServer();
    renderPage("settings");
    await screen.findByRole("checkbox", { name: /Use Gemini 4 \(Pro model\)/ });
    const thinking = screen.getByRole("combobox", { name: /Interaction thinking level/ });
    expect(within(thinking).getByRole("option", { name: "minimal" })).toBeDisabled();
    expect(within(thinking).getByRole("option", { name: "medium" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: /Top P/ })).toBeDisabled();
  });

  it("shows the region warning for Vertex Generate Content in a single region", async () => {
    saveSettings({ provider: "vertex", vertexApi: "generateContent", region: "europe-west1", proModel: true });
    stubServer();
    renderPage("settings");
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose the global endpoint or the us or eu multi-region");
  });
});

describe("saved settings", () => {
  it("loads settings saved before the toggle existed with Gemini 4 off", () => {
    const { proModel: _proModel, ...older } = FALLBACK_SETTINGS;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(older));
    expect(loadSettings().proModel).toBe(false);
  });

  it("ignores a non-boolean value", () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...FALLBACK_SETTINGS, proModel: "yes" }));
    expect(loadSettings().proModel).toBe(false);
  });
});
