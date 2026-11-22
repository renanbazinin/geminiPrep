// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AppSettings, LargeFilesConfig, PublicConfig } from "../../shared/contracts";
import { AppProvider } from "../contexts/AppContext";
import { ConfigProvider } from "../contexts/ConfigContext";
import { FALLBACK_SETTINGS } from "../lib/storage";
import { SettingsPage } from "./SettingsPage";

const SETTINGS_KEY = "gemini-prep:settings:v1";
const FLASH = { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", family: "3.x" };
const LIMITS: LargeFilesConfig = {
  maxUploadBytes: 100 * 1024 * 1024,
  serverThresholdBytes: 512 * 1024,
  inlineTokens: 200_000,
  pdfInlineMaxBytes: 7 * 1024 * 1024,
  ttlHours: 72,
  engine: "npm",
};

function serverConfig(largeFiles?: LargeFilesConfig): PublicConfig {
  return {
    appName: "Test", project: "project-one",
    regions: [{ id: "global", label: "Global", group: "global" }],
    defaults: { provider: "gemini", vertexModel: FLASH.id, geminiModel: FLASH.id, region: "global" },
    providers: {
      vertex: { id: "vertex", label: "Vertex", ready: true, status: "Ready", models: [FLASH] },
      gemini: { id: "gemini", label: "Gemini", ready: true, status: "Ready", models: [FLASH] },
    },
    ...(largeFiles ? { largeFiles } : {}),
  };
}

function stubConfig(config: PublicConfig) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/config") return new Response(JSON.stringify(config));
    throw new Error(`Unexpected request: ${url}`);
  }));
}

const savedSettings = (): AppSettings => JSON.parse(localStorage.getItem(SETTINGS_KEY)!) as AppSettings;

function renderPage() {
  return render(<MemoryRouter><AppProvider><ConfigProvider><SettingsPage /></ConfigProvider></AppProvider></MemoryRouter>);
}

async function largeFilesSection() {
  const heading = await screen.findByRole("heading", { name: "Large files" });
  return within(heading.closest("section")!);
}

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });

describe("Large files settings", () => {
  it("is hidden when the server sends no large-file limits", async () => {
    stubConfig(serverConfig());
    renderPage();
    await screen.findByText("Gemini 3.8 Flash · gemini-3.8-flash");
    expect(screen.queryByRole("heading", { name: "Large files" })).not.toBeInTheDocument();
  });

  it("shows the server's values as placeholders, its limits, and what the npm engine does with them", async () => {
    stubConfig(serverConfig(LIMITS));
    renderPage();
    const section = await largeFilesSection();
    const size = section.getByRole("spinbutton", { name: /Upload text, DOCX and PPTX above/ });
    expect(size).toHaveValue(null);
    expect(size).toHaveAttribute("placeholder", "Server default: 512");
    expect(size).toHaveAttribute("min", "1");
    expect(size).toHaveAttribute("max", String(20 * 1024));
    expect(section.getByRole("spinbutton", { name: /Upload PDFs above/ })).toHaveAttribute("placeholder", "Server default: 7");
    const tokens = section.getByRole("spinbutton", { name: /Search files above/ });
    expect(tokens).toHaveAttribute("placeholder", "Server default: 200,000");
    expect(tokens).toHaveAttribute("max", "200000");
    expect(section.getByText("100 MB per file · kept 72 hours")).toBeInTheDocument();
    expect(section.getByText(/Engine: llm-large-files \(npm\)/)).toBeInTheDocument();
    // The server's number is a shared room for its files, while the browser applies it per file.
    expect(section.getByText(/uploads each file with more text than this/)).toBeInTheDocument();
    expect(section.getByText(/read in full, smallest first,\s+while their text together stays under this amount and fits the model's context/)).toBeInTheDocument();
    // npm: the threshold is sent with each question, and reaches files attached earlier too.
    const help = section.getByText(/sent with each question, and the server plans with it/);
    expect(help).toHaveTextContent(/counts tokens again on the text it prepares, so a file uploaded for its length is usually searched there too/);
    expect(help).toHaveTextContent(/applies at each question to every file on the server, including ones you attached earlier/);
    expect(help).not.toHaveTextContent(/keep the routing/);
    expect(section.getByRole("button", { name: "Use server defaults" })).toBeDisabled();
  });

  it("says the original engine keeps the server's token threshold", async () => {
    stubConfig(serverConfig({ ...LIMITS, engine: "original" }));
    renderPage();
    const section = await largeFilesSection();
    const help = section.getByText(/plans with its own token threshold \(200,000\)/);
    expect(help).toHaveTextContent(/Files already attached keep the routing they were given/);
    expect(help).not.toHaveTextContent(/every file on the server/);
    expect(section.getByText(/Engine: original/)).toBeInTheDocument();
  });

  it("saves each threshold, clamps it to the server's bounds, and resets to the server's values", async () => {
    stubConfig(serverConfig(LIMITS));
    renderPage();
    const section = await largeFilesSection();
    const size = section.getByRole("spinbutton", { name: /Upload text, DOCX and PPTX above/ });
    const pdf = section.getByRole("spinbutton", { name: /Upload PDFs above/ });
    const tokens = section.getByRole("spinbutton", { name: /Search files above/ });

    fireEvent.change(size, { target: { value: "4096" } });
    fireEvent.change(pdf, { target: { value: "3.5" } });
    fireEvent.change(tokens, { target: { value: "50000" } });
    expect(savedSettings().largeFiles).toEqual({ serverThresholdKb: 4096, pdfInlineMaxMb: 3.5, inlineTokens: 50_000 });

    // Above the maximum is lowered at once; below the minimum is raised when the field is left.
    fireEvent.change(size, { target: { value: "999999" } });
    fireEvent.change(pdf, { target: { value: "50" } });
    expect(size).toHaveValue(20 * 1024);
    expect(pdf).toHaveValue(7);
    fireEvent.change(tokens, { target: { value: "20" } });
    expect(tokens).toHaveValue(20);
    fireEvent.blur(tokens);
    expect(tokens).toHaveValue(1_000);
    expect(savedSettings().largeFiles).toEqual({ serverThresholdKb: 20 * 1024, pdfInlineMaxMb: 7, inlineTokens: 1_000 });

    // Emptying a field gives it back to the server.
    fireEvent.change(pdf, { target: { value: "" } });
    expect(savedSettings().largeFiles?.pdfInlineMaxMb).toBeNull();

    fireEvent.click(section.getByRole("button", { name: "Use server defaults" }));
    expect(savedSettings()).not.toHaveProperty("largeFiles");
    expect(size).toHaveValue(null);
    expect(tokens).toHaveValue(null);
    expect(section.getByRole("button", { name: "Use server defaults" })).toBeDisabled();
  });

  it("keeps saved thresholds above what this server allows, and says which limit applies", async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...FALLBACK_SETTINGS, largeFiles: { inlineTokens: 900_000, serverThresholdKb: 2048 } }));
    stubConfig(serverConfig(LIMITS));
    renderPage();
    const section = await largeFilesSection();
    expect(section.getByRole("spinbutton", { name: /Search files above/ })).toHaveValue(900_000);
    expect(section.getByText("This server allows at most 200,000 tokens, so it uses 200,000 instead of your 900,000.")).toBeInTheDocument();
    expect(section.getByRole("spinbutton", { name: /Upload text, DOCX and PPTX above/ })).toHaveValue(2048);
    expect(section.queryByText(/This server allows at most .* KB/)).not.toBeInTheDocument();
    // The saved value is not lowered, so it applies again if the server raises its limit.
    expect(savedSettings().largeFiles).toEqual({ inlineTokens: 900_000, serverThresholdKb: 2048 });
  });
});
