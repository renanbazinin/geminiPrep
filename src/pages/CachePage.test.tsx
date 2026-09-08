// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TestLanguageProvider } from "../contexts/TestLanguageContext";
import { CachePage } from "./CachePage";

vi.mock("../contexts/AppContext", () => ({ useApp: () => ({ settings: { thinkingLevel: "low" } }) }));
vi.mock("../components/MarkdownMessage", () => ({ MarkdownMessage: ({ children }: { children: string }) => <p>{children}</p> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it.each(["en", "he"])("creates a name cache and asks through its reference without resending the name (%s)", async (language) => {
  localStorage.setItem("gemini-prep:test-language:v1", language);
  const name = "Test Person אבג";
  const resource = {
    name: "projects/demo/locations/global/cachedContents/name-test",
    model: "projects/demo/locations/global/publishers/google/models/gemini-3.6-flash",
    expireTime: new Date(Date.now() + 300_000).toISOString(),
  };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith("/config")) return new Response(JSON.stringify({
      project: "demo", models: [{ id: "gemini-3.6-flash", label: "Flash" }], regions: [{ id: "global", label: "Global" }],
      defaults: { model: "gemini-3.6-flash", implicitModel: "gemini-3.6-flash", region: "global", ttlSeconds: 3600 },
      limits: { minimumTokensGemini3: 4096, minimumTtlSeconds: 60 },
    }));
    requests.push({ path, body: JSON.parse(init?.body as string) });
    if (path.endsWith("/create")) return new Response(JSON.stringify(resource));
    if (path.endsWith("/use")) return new Response(JSON.stringify({ text: name, latencyMs: 20, usageMetadata: { cachedContentTokenCount: 5000 } }));
    throw new Error(`Unexpected request: ${path}`);
  }));
  render(<TestLanguageProvider><CachePage /></TestLanguageProvider>);
  const prepare = screen.getByRole("button", { name: language === "en" ? "Prepare name test" : "הכנת בדיקת השם" });
  expect(prepare).toBeDisabled();
  fireEvent.change(screen.getByLabelText(language === "en" ? "Your name" : "השם שלך"), { target: { value: name } });
  await waitFor(() => expect(prepare).toBeEnabled());
  fireEvent.click(prepare);
  expect(requests).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: language === "en" ? "Create cache" : "יצירת מטמון" }));
  const generate = await screen.findByRole("button", { name: language === "en" ? "Generate with cache" : "יצירה עם המטמון" });
  expect(requests[0].body).toMatchObject({ content: expect.stringContaining(name), expirationMode: "ttl", ttlSeconds: 300 });
  fireEvent.click(generate);
  await screen.findByText("CACHE HIT");
  expect(requests[1].body).toMatchObject({ name: resource.name, prompt: language === "en" ? "What is my name?" : "מה השם שלי?" });
  expect(JSON.stringify(requests[1].body)).not.toContain(name);
  expect(requests[1].body).not.toHaveProperty("content");
  expect(requests[1].body).not.toHaveProperty("systemInstruction");
  expect(screen.getByText(name)).toBeInTheDocument();
});
