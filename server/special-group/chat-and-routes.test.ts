import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import express from "express";
import request from "supertest";
import { runSpecialGroupChat } from "./chat.js";
import { LOCAL_ENV_FILE } from "./config.js";
import { clearProjectOptionsCache } from "./jira-lookups.js";
import { runToolLoop } from "./model-loop.js";
import { ReadOnlyJiraClient } from "./read-only-client.js";
import { specialGroupRoutes } from "./routes.js";

const config = { siteUrl: "https://example.atlassian.net", baseUrl: "https://example.atlassian.net", email: "me@example.com", token: "secret-token", defaultProjectKey: "DESK" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const JIRA: Record<string, unknown> = {
  "GET /rest/api/3/myself": { displayName: "Reader" },
  "GET /rest/api/3/project/search": { values: [{ id: "10000", key: "DESK", name: "DeskFlow" }] },
  "GET /rest/api/3/project/DESK": { id: "10000", key: "DESK", name: "DeskFlow", style: "next-gen", issueTypes: [{ id: "10001", name: "Epic", hierarchyLevel: 1 }] },
  "GET /rest/api/3/issue/createmeta/DESK/issuetypes": { issueTypes: [{ id: "10004", name: "Bug", subtask: false }] },
  "GET /rest/api/3/priority/search": { values: [{ id: "2", name: "High" }] },
  "GET /rest/api/3/project/DESK/components": [],
  "GET /rest/api/3/project/DESK/versions": [],
  "POST /rest/api/3/search/jql": { issues: [{ key: "DESK-12", fields: { summary: "Booking", status: { name: "To Do" } } }] },
};
const modelTurn = (...parts: unknown[]) => json({ candidates: [{ content: { role: "model", parts } }] });

/** One fetch for both Jira (by path) and the model (answers queued in order). */
function fakeServices(modelAnswers: Response[]) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "generativelanguage.googleapis.com") return modelAnswers.shift() ?? json({ error: { message: "no more answers" } }, 500);
    if (url.pathname === "/_edge/tenant_info") return json({ cloudId: "abc-123" });
    const route = JIRA[`${init?.method ?? "GET"} ${url.pathname.replace(/^\/ex\/jira\/[^/]+/, "")}`];
    return route === undefined ? json({}, 404) : json(route);
  });
}
const modelCalls = (fetcher: ReturnType<typeof fakeServices>) =>
  fetcher.mock.calls.filter(([url]) => String(url).includes("generativelanguage")).map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) }));
const chatRequest = { provider: "gemini" as const, model: "gemini-3.8-flash", temperature: 1, maxOutputTokens: 1024, messages: [{ role: "user" as const, content: "Safari crash when booking" }] };

beforeEach(() => { clearProjectOptionsCache(); vi.stubEnv("GEMINI_API_KEY", "model-key"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("runToolLoop", () => {
  it("returns the model's turn unchanged, answers each call by id, and feeds tool errors back", async () => {
    const turn = { role: "model", parts: [{ thoughtSignature: "sig", functionCall: { id: "a", name: "ok_tool", args: { x: 1 } } }, { functionCall: { id: "b", name: "bad_tool", args: {} } }] };
    const fetcher = vi.fn().mockResolvedValueOnce(json({ candidates: [{ content: turn }] })).mockResolvedValueOnce(modelTurn({ text: "Done." }));
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    const result = await runToolLoop({ url: "https://model", init: { method: "POST" }, body, fetchImpl: fetcher,
      execute: async name => { if (name === "bad_tool") throw new Error("nope"); return { fine: true }; } });
    expect(result.text).toBe("Done.");
    expect(result.calls.map(c => [c.tool, c.ok])).toEqual([["ok_tool", true], ["bad_tool", false]]);
    const second = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(second.contents[1]).toEqual(turn);
    expect(second.contents[2].parts.map((p: any) => [p.functionResponse.id, p.functionResponse.response.result])).toEqual([["a", { fine: true }], ["b", { error: "nope" }]]);
  });
});

describe("runSpecialGroupChat", () => {
  it("lets the model look things up, fill the draft, and returns a ready link", async () => {
    const fetcher = fakeServices([
      modelTurn({ functionCall: { name: "get_project_options", args: { projectKey: "DESK" } } }),
      modelTurn({ functionCall: { name: "update_ticket_draft", args: { projectKey: "DESK", issueType: "Bug", summary: "Safari crash", parentKey: "DESK-12", priority: "High" } } }),
      modelTurn({ text: "Draft ready. Open it in Jira." }),
    ]);
    const result = await runSpecialGroupChat({ request: chatRequest, draft: { labels: ["web"] }, client: new ReadOnlyJiraClient(config, fetcher), project: null, fetchImpl: fetcher, today: "2026-10-11" });
    expect(result.text).toBe("Draft ready. Open it in Jira.");
    expect(result.lookups.map(l => l.tool)).toEqual(["get_project_options", "update_ticket_draft"]);
    expect(result.draft).toMatchObject({ labels: ["web"], issueType: { id: "10004" }, parent: { key: "DESK-12" }, priority: { id: "2" } });
    const url = new URL(result.link!.url!);
    expect(url.searchParams.get("pid")).toBe("10000");
    expect(url.searchParams.get("parent")).toBe("DESK-12");

    const calls = modelCalls(fetcher);
    expect(calls[0]!.url).toContain(":generateContent");
    expect(calls[0]!.body.systemInstruction.parts[0].text).toContain('"labels":["web"]');
    expect(calls[0]!.body.tools[0].functionDeclarations.map((t: any) => t.name)).toContain("update_ticket_draft");
    // The model sees whether the link is ready, never the URL itself.
    expect(JSON.stringify(calls[2]!.body.contents)).not.toContain("CreateIssueDetails");
  });

  it("returns no draft when the model only chatted", async () => {
    const fetcher = fakeServices([modelTurn({ text: "Which project?" })]);
    const result = await runSpecialGroupChat({ request: chatRequest, draft: {}, client: new ReadOnlyJiraClient(config, fetcher), project: null, fetchImpl: fetcher });
    expect(result).toEqual({ text: "Which project?", lookups: [] });
  });
});

describe("Special Group routes", () => {
  const app = (fetcher: ReturnType<typeof fakeServices>, overrides: Partial<typeof config> = {}) => {
    const server = express(); server.use(express.json());
    server.use("/api/special-group", specialGroupRoutes({ fetchImpl: fetcher, config: () => ({ ...config, ...overrides }) }));
    return server;
  };

  it("never returns the token and blocks other hosts and origins", async () => {
    const server = app(fakeServices([]));
    const response = await request(server).get("/api/special-group/config");
    expect(response.body).toEqual({ configured: true, siteUrl: config.siteUrl, defaultProjectKey: "DESK", readOnly: true });
    expect(JSON.stringify(response.body)).not.toContain(config.token);
    expect((await request(server).get("/api/special-group/projects").set("Origin", "https://evil.example")).status).toBe(403);
    expect((await request(server).get("/api/special-group/config").set("Host", "evil.example")).status).toBe(403);
  });

  it("serves the prompt, projects, and project options", async () => {
    const server = app(fakeServices([]));
    expect((await request(server).get("/api/special-group/prompt")).body.prompt).toContain("cannot create or change anything in Jira");
    expect((await request(server).get("/api/special-group/projects")).body.projects).toEqual([{ id: "10000", key: "DESK", name: "DeskFlow" }]);
    expect((await request(server).get("/api/special-group/projects/DESK/options")).body.parentParam).toEqual({ name: "parent", mode: "parent" });
  });

  it("rejects chat requests that try to use files or tools, and sanitizes the draft", async () => {
    const fetcher = fakeServices([modelTurn({ text: "ok" })]);
    const server = app(fetcher);
    const bad = await request(server).post("/api/special-group/chat").send({ ...chatRequest, tool: "image" });
    expect(bad.status).toBe(400);
    const good = await request(server).post("/api/special-group/chat").send({ ...chatRequest, draft: { summary: "x", evil: 1, project: { id: "zzz" } } });
    expect(good.status).toBe(200);
    expect(modelCalls(fetcher)[0]!.body.systemInstruction.parts[0].text).toContain('Current draft (may include the person\'s own edits): {"summary":"x"}');
  });

  it("asks to connect when there is no token", async () => {
    const response = await request(app(fakeServices([]), { token: "" })).post("/api/special-group/chat").send(chatRequest);
    expect(response.status).toBe(503);
  });

  it("verifies a scoped token through the gateway before saving it", async () => {
    const fetcher = fakeServices([]);
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const response = await request(app(fetcher, { token: "" })).post("/api/special-group/connect")
      .send({ siteUrl: "https://example.atlassian.net", email: "me@example.com", token: "new-token-123", scoped: true });
    expect(response.body).toEqual({ connected: true, account: "Reader", projects: 1 });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toContain("https://api.atlassian.com/ex/jira/abc-123/rest/api/3/myself");
    expect(write).toHaveBeenCalledWith(LOCAL_ENV_FILE, expect.stringContaining("SPECIAL_GROUP_JIRA_API_BASE_URL=https://api.atlassian.com/ex/jira/abc-123"), { mode: 0o600 });
  });

  it("doesn't save, and redacts the token, when verification fails", async () => {
    const fetcher = vi.fn(async () => json({ errorMessages: ["bad new-token-123"] }, 401));
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => undefined);
    const response = await request(app(fetcher as any)).post("/api/special-group/connect")
      .send({ siteUrl: "https://example.atlassian.net", email: "me@example.com", token: "new-token-123", scoped: false });
    expect(response.status).toBe(400);
    expect(response.body.error).not.toContain("new-token-123");
    expect(write).not.toHaveBeenCalled();
  });
});
