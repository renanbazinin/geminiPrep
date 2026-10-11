// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SpecialGroupPage } from "./SpecialGroupPage";

vi.mock("../contexts/AppContext", () => ({ useApp: () => ({ settings: {
  provider: "gemini", models: { gemini: "gemini-3.8-flash" }, region: "global", temperature: 1, maxOutputTokens: 2048, thinkingLevel: "medium",
} }) }));
vi.mock("../components/MarkdownMessage", () => ({ MarkdownMessage: ({ children }: { children: string }) => <div>{children}</div> }));

const SITE = "https://example.atlassian.net";
const project = { id: "10000", key: "DESK", name: "DeskFlow" };
const options = {
  project: { ...project, style: "next-gen" },
  issueTypes: [{ id: "10004", name: "Bug", subtask: false }, { id: "10005", name: "Story", subtask: false }],
  priorities: [{ id: "2", name: "High" }], components: [{ id: "201", name: "Web" }], versions: [],
  epics: [{ key: "DESK-12", summary: "Booking", status: "To Do" }], parentParam: { name: "parent", mode: "parent" },
};
const draftFromModel = { project, issueType: { id: "10004", name: "Bug" }, summary: "Safari crash", parent: { key: "DESK-12", summary: "Booking" } };
const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));

function fakeApi(configured = true) {
  let connected = configured;
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/config")) return ok({ configured: connected, siteUrl: SITE, defaultProjectKey: "DESK", readOnly: true });
    if (url.endsWith("/connect")) { connected = true; return ok({ connected: true, account: "Reader", projects: 1 }); }
    if (url.includes("/projects/DESK/options")) return ok(options);
    if (url.includes("/projects")) return ok({ projects: [project] });
    if (url.endsWith("/prompt")) return ok({ prompt: "You are the Special Group ticket assistant." });
    if (url.endsWith("/chat")) {
      const body = JSON.parse(String(init?.body));
      return ok({ text: `Draft ready (${body.messages.length} message).`, draft: draftFromModel,
        link: { url: `${SITE}/secure/CreateIssueDetails!init.jspa?pid=10000&issuetype=10004`, missing: [], warnings: [] },
        lookups: [{ tool: "get_project_options", args: { projectKey: "DESK" }, ok: true, result: {} }] });
    }
    return ok({});
  });
}
const renderPage = () => render(<MemoryRouter><SpecialGroupPage /></MemoryRouter>);
const draftCard = () => within(screen.getByRole("region", { name: "Ticket draft" }));

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Special Group page", () => {
  it("connects with a token that never reaches browser storage", async () => {
    vi.stubGlobal("fetch", fakeApi(false));
    renderPage();
    fireEvent.change(await screen.findByLabelText("API token"), { target: { value: "secret-token-value" } });
    fireEvent.change(screen.getByLabelText("Atlassian email"), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and save" }));
    expect(await screen.findByRole("button", { name: /Connected/ })).toBeTruthy();
    expect(screen.queryByLabelText("API token")).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain("secret-token-value");
  });

  it("starts in the default project, sends the draft with the chat, and shows the answer's Jira link", async () => {
    const fetcher = fakeApi();
    vi.stubGlobal("fetch", fetcher);
    renderPage();
    expect(await draftCard().findByDisplayValue("DeskFlow (DESK)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message the ticket assistant"), { target: { value: "Safari crashes when I pick a date" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Draft ready (1 message).");

    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith("/chat"))!;
    const body = JSON.parse(String(call[1]!.body));
    expect(body).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash", draft: { project } });
    expect(body).not.toHaveProperty("thinkingLevel"); // "medium" isn't accepted by the server validator.

    const chat = within(screen.getByRole("region", { name: "Special Group chat" }));
    expect(chat.getByRole("link", { name: /Open in Jira/ }).getAttribute("href")).toContain("pid=10000");
    expect(chat.getByText("1 Jira lookup")).toBeTruthy();
    expect((draftCard().getByLabelText("Summary") as HTMLInputElement).value).toBe("Safari crash");
  });

  it("rebuilds the draft card's link live as fields are edited", async () => {
    vi.stubGlobal("fetch", fakeApi());
    localStorage.setItem("gemini-prep-special-group-sessions-v1", JSON.stringify([{ id: "s1", title: "Saved", createdAt: "", updatedAt: "", messages: [], draft: draftFromModel }]));
    renderPage();
    await draftCard().findByRole("option", { name: "Story" });
    fireEvent.change(draftCard().getByLabelText("Summary"), { target: { value: "Date picker crash" } });
    fireEvent.change(draftCard().getByLabelText("Work type"), { target: { value: "10005" } });
    fireEvent.click(draftCard().getByRole("button", { name: "Web" }));
    const href = new URL(draftCard().getByRole("link", { name: /Open in Jira/ }).getAttribute("href")!);
    expect(href.searchParams.get("summary")).toBe("Date picker crash");
    expect(href.searchParams.get("issuetype")).toBe("10005");
    expect(href.searchParams.get("parent")).toBe("DESK-12");
    expect(href.searchParams.getAll("components")).toEqual(["201"]);
  });

  it("keeps separate sessions, each with its own draft", async () => {
    vi.stubGlobal("fetch", fakeApi());
    localStorage.setItem("gemini-prep-special-group-sessions-v1", JSON.stringify([{ id: "s1", title: "Saved", createdAt: "", updatedAt: "", messages: [], draft: draftFromModel }]));
    renderPage();
    expect((await draftCard().findByLabelText("Summary") as HTMLInputElement).value).toBe("Safari crash");
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect((draftCard().getByLabelText("Summary") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /^Saved/ }));
    expect((draftCard().getByLabelText("Summary") as HTMLInputElement).value).toBe("Safari crash");
    expect(JSON.parse(localStorage.getItem("gemini-prep-special-group-sessions-v1")!)).toHaveLength(2);
  });
});
