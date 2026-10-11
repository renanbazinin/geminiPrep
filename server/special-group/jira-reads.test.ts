import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDraftUpdate, parseDraftUpdate } from "./draft-resolver.js";
import { clearProjectOptionsCache, findPeople, getProjectOptions } from "./jira-lookups.js";
import { isAllowedReadPath, ReadOnlyJiraClient } from "./read-only-client.js";

const config = { siteUrl: "https://example.atlassian.net", baseUrl: "https://example.atlassian.net", email: "me@example.com", token: "secret-token", defaultProjectKey: "DESK" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A pretend Jira: answers by "METHOD /path" (query string ignored). */
function fakeJira(overrides: Record<string, unknown> = {}) {
  const routes: Record<string, unknown> = {
    "GET /rest/api/3/myself": { displayName: "Reader" },
    "GET /rest/api/3/project/search": { values: [{ id: "10000", key: "DESK", name: "DeskFlow" }] },
    "GET /rest/api/3/project/DESK": { id: "10000", key: "DESK", name: "DeskFlow", style: "classic",
      issueTypes: [{ id: "10001", name: "Epic", hierarchyLevel: 1 }, { id: "10004", name: "Bug", hierarchyLevel: 0 }] },
    "GET /rest/api/3/issue/createmeta/DESK/issuetypes": { issueTypes: [
      { id: "10001", name: "Epic", subtask: false }, { id: "10004", name: "Bug", subtask: false },
      { id: "10005", name: "Story", subtask: false }, { id: "10006", name: "Subtask", subtask: true }] },
    "GET /rest/api/3/priority/search": { values: [{ id: "2", name: "High" }, { id: "3", name: "Medium" }] },
    "GET /rest/api/3/project/DESK/components": [{ id: "201", name: "Web" }, { id: "202", name: "API" }],
    "GET /rest/api/3/project/DESK/versions": [{ id: "301", name: "1.4", released: false }, { id: "300", name: "1.3", released: true }],
    "GET /rest/api/3/field": [{ id: "customfield_10014", name: "Epic Link", schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" } }],
    "POST /rest/api/3/search/jql": { issues: [{ key: "DESK-12", fields: { summary: "Booking", status: { name: "In Progress" } } }] },
    "GET /rest/api/3/user/search": [
      { accountId: "acc-dana", displayName: "Dana Levi", active: true, accountType: "atlassian" },
      { accountId: "acc-bot", displayName: "Dana Bot", active: true, accountType: "app" },
    ],
    "GET /rest/api/3/issue/DESK-40": { key: "DESK-40", fields: { summary: "Older parent" } },
    ...overrides,
  };
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
    if (route === undefined) return json({ errorMessages: ["Not found"] }, 404);
    return route instanceof Response ? route : json(route);
  });
}

beforeEach(() => clearProjectOptionsCache());

describe("ReadOnlyJiraClient", () => {
  it("allows only listed read endpoints", () => {
    expect(isAllowedReadPath("/rest/api/3/project/DESK")).toBe(true);
    expect(isAllowedReadPath("/rest/api/3/issue/DESK-1?fields=summary")).toBe(true);
    expect(isAllowedReadPath("/rest/api/3/issue")).toBe(false);
    expect(isAllowedReadPath("/rest/api/3/issue/DESK-1/transitions")).toBe(false);
    expect(isAllowedReadPath("/rest/api/3/issue/DESK-1/comment")).toBe(false);
    expect(isAllowedReadPath("/rest/api/3/project/DESK/../../issue")).toBe(false);
  });

  it("refuses blocked paths before any network call and only ever sends GET or the search POST", async () => {
    const fetcher = fakeJira();
    const client = new ReadOnlyJiraClient(config, fetcher);
    expect(() => client.get("/rest/api/3/issue")).toThrow("Blocked");
    await client.get("/rest/api/3/myself");
    await client.searchJql({ jql: "project = DESK", fields: [], maxResults: 1 });
    expect(fetcher.mock.calls.map(([url, init]) => `${init?.method} ${new URL(String(url)).pathname}`))
      .toEqual(["GET /rest/api/3/myself", "POST /rest/api/3/search/jql"]);
  });

  it("redacts the token from error messages", async () => {
    const fetcher = vi.fn(async () => json({ errorMessages: ["bad secret-token"] }, 400));
    await expect(new ReadOnlyJiraClient(config, fetcher).get("/rest/api/3/myself")).rejects.toThrow("[REDACTED]");
  });
});

describe("Jira lookups", () => {
  it("collects project options: creatable types, unreleased versions, open epics, epic-link field", async () => {
    const options = await getProjectOptions(new ReadOnlyJiraClient(config, fakeJira()), "desk");
    expect(options.project).toEqual({ id: "10000", key: "DESK", name: "DeskFlow", style: "classic" });
    expect(options.issueTypes.map(t => t.name)).toEqual(["Epic", "Bug", "Story", "Subtask"]);
    expect(options.versions).toEqual([{ id: "301", name: "1.4" }]);
    expect(options.epics).toEqual([{ key: "DESK-12", summary: "Booking", status: "In Progress" }]);
    expect(options.parentParam).toEqual({ name: "customfield_10014", mode: "epic-link" });
  });

  it("uses the parent field for team-managed projects and survives optional reads failing", async () => {
    const fetcher = fakeJira({
      "GET /rest/api/3/project/DESK": { id: "10000", key: "DESK", name: "DeskFlow", style: "next-gen", issueTypes: [] },
      "GET /rest/api/3/priority/search": new Response("{}", { status: 403 }),
    });
    const options = await getProjectOptions(new ReadOnlyJiraClient(config, fetcher), "DESK");
    expect(options.parentParam).toEqual({ name: "parent", mode: "parent" });
    expect(options.priorities).toEqual([]);
  });

  it("returns only active human accounts, without emails", async () => {
    expect(await findPeople(new ReadOnlyJiraClient(config, fakeJira()), "dana")).toEqual([{ accountId: "acc-dana", displayName: "Dana Levi" }]);
  });
});

describe("applyDraftUpdate", () => {
  const client = () => new ReadOnlyJiraClient(config, fakeJira());

  it("resolves names to Jira IDs", async () => {
    const { draft, notes } = await applyDraftUpdate(client(), {}, parseDraftUpdate({
      projectKey: "DESK", issueType: "bug", summary: "  Crash   on Safari ", parentKey: "DESK-12", priority: "High",
      reporter: "Dana Levi", labels: ["safari", "safari", "needs review"], components: ["Web"], fixVersions: ["1.4"],
    }));
    expect(notes).toEqual([]);
    expect(draft).toEqual({
      project: { id: "10000", key: "DESK", name: "DeskFlow" }, issueType: { id: "10004", name: "Bug" },
      summary: "Crash on Safari", parent: { key: "DESK-12", summary: "Booking" }, priority: { id: "2", name: "High" },
      reporter: { accountId: "acc-dana", displayName: "Dana Levi" }, labels: ["safari", "needs-review"],
      components: [{ id: "201", name: "Web" }], fixVersions: [{ id: "301", name: "1.4" }],
    });
  });

  it("explains unknown values instead of guessing, and keeps the rest", async () => {
    const { draft, notes } = await applyDraftUpdate(client(), {}, parseDraftUpdate({ projectKey: "DESK", issueType: "Incident", components: ["Mobile", "API"] }));
    expect(draft.issueType).toBeUndefined();
    expect(draft.components).toEqual([{ id: "202", name: "API" }]);
    expect(notes.join(" ")).toContain('Work type "Incident"');
    expect(notes.join(" ")).toContain('Component "Mobile"');
  });

  it("refuses subtask types and parents from other projects, accepts a visible non-epic parent", async () => {
    const r1 = await applyDraftUpdate(client(), {}, parseDraftUpdate({ projectKey: "DESK", issueType: "Subtask", parentKey: "OTHER-1" }));
    expect(r1.draft.issueType).toBeUndefined();
    expect(r1.draft.parent).toBeUndefined();
    const r2 = await applyDraftUpdate(client(), r1.draft, parseDraftUpdate({ parentKey: "DESK-40" }));
    expect(r2.draft.parent).toEqual({ key: "DESK-40", summary: "Older parent" });
  });

  it("asks which person when a name is ambiguous", async () => {
    const fetcher = fakeJira({ "GET /rest/api/3/user/search": [
      { accountId: "a1", displayName: "Dana Levi", active: true }, { accountId: "a2", displayName: "Dana Cohen", active: true }] });
    const { draft, notes } = await applyDraftUpdate(new ReadOnlyJiraClient(config, fetcher), {}, parseDraftUpdate({ assignee: "Dana" }));
    expect(draft.assignee).toBeUndefined();
    expect(notes[0]).toContain("Dana Levi, Dana Cohen");
  });

  it("resets project-scoped fields when the project changes, and clears fields on request", async () => {
    const fetcher = fakeJira({
      "GET /rest/api/3/project/OPS": { id: "20000", key: "OPS", name: "Ops", style: "next-gen", issueTypes: [] },
    });
    const start = { project: { id: "10000", key: "DESK", name: "DeskFlow" }, issueType: { id: "10004", name: "Bug" }, summary: "Keep me", labels: ["x"] };
    const { draft, notes } = await applyDraftUpdate(new ReadOnlyJiraClient(config, fetcher), start, parseDraftUpdate({ projectKey: "OPS", clear: ["labels", "project"] }));
    expect(draft).toEqual({ project: { id: "20000", key: "OPS", name: "Ops" }, summary: "Keep me" });
    expect(notes[0]).toContain("Project changed");
  });
});
