import { describe, expect, it } from "vitest";
import { buildCreateLink, CREATE_ISSUE_PATH, MAX_SAFE_LINK_LENGTH, normalizeLabel } from "../../shared/special-group/create-link.js";
import { sanitizeDraft } from "../../shared/special-group/draft.js";
import type { TicketDraft } from "../../shared/special-group/types.js";

const SITE = "https://example.atlassian.net";
const full: TicketDraft = {
  project: { id: "10000", key: "DESK", name: "DeskFlow" },
  issueType: { id: "10004", name: "Bug" },
  summary: "Date picker crashes on Safari",
  description: "Steps:\n1. Open booking\n2. Pick a date & time",
  parent: { key: "DESK-12", summary: "Booking" },
  priority: { id: "2", name: "High" },
  reporter: { accountId: "acc:reporter", displayName: "Dana" },
  assignee: { accountId: "acc:assignee", displayName: "Renan" },
  labels: ["safari", "booking flow"],
  components: [{ id: "201", name: "Web" }, { id: "202", name: "API" }],
  fixVersions: [{ id: "301", name: "1.4" }],
};

describe("buildCreateLink", () => {
  it("maps every draft field to Jira's create-screen parameters", () => {
    const link = buildCreateLink(SITE + "/", full, { name: "customfield_10014", mode: "epic-link" });
    expect(link.missing).toEqual([]);
    expect(link.warnings).toEqual([]);
    const url = new URL(link.url!);
    expect(url.origin + url.pathname).toBe(SITE + CREATE_ISSUE_PATH);
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => !["labels", "components"].includes(k)))).toEqual({
      pid: "10000", issuetype: "10004", summary: "Date picker crashes on Safari",
      description: "Steps:\n1. Open booking\n2. Pick a date & time", priority: "2",
      reporter: "acc:reporter", assignee: "acc:assignee", fixVersions: "301", customfield_10014: "DESK-12",
    });
    expect(url.searchParams.getAll("labels")).toEqual(["safari", "booking-flow"]);
    expect(url.searchParams.getAll("components")).toEqual(["201", "202"]);
  });

  it("encodes spaces as %20 and keeps a literal plus sign", () => {
    const url = buildCreateLink(SITE, { ...full, summary: "C++ build fails" }).url!;
    expect(url).toContain("summary=C%2B%2B%20build%20fails");
    expect(url).not.toMatch(/\+/);
  });

  it("uses the standard parent field for team-managed projects", () => {
    expect(new URL(buildCreateLink(SITE, full, { name: "parent", mode: "parent" }).url!).searchParams.get("parent")).toBe("DESK-12");
  });

  it("warns instead of guessing when the parent can't be prefilled", () => {
    const link = buildCreateLink(SITE, full, null);
    expect(link.url).not.toContain("DESK-12");
    expect(link.warnings[0]).toContain("DESK-12");
  });

  it("needs a project and work type before a link exists", () => {
    expect(buildCreateLink(SITE, { summary: "x" })).toEqual({ url: null, missing: ["project", "work type"], warnings: [] });
    expect(buildCreateLink(SITE, { project: full.project, issueType: full.issueType }).missing).toEqual(["summary"]);
  });

  it("warns when the link gets long enough to be cut off", () => {
    const link = buildCreateLink(SITE, { ...full, description: "x".repeat(MAX_SAFE_LINK_LENGTH) });
    expect(link.warnings.some(w => w.includes("cut off"))).toBe(true);
  });

  it("normalizes labels", () => { expect(normalizeLabel("  needs  review ")).toBe("needs-review"); });
});

describe("sanitizeDraft", () => {
  it("keeps valid fields and drops malformed or unknown ones", () => {
    const draft = sanitizeDraft({
      ...full, project: { id: "10000", key: "desk", name: "x" }, issueType: { id: "not-a-number", name: "Bug" },
      reporter: { accountId: "bad id with spaces", displayName: "x" }, labels: ["a b", 3, "a-b"], evil: "<script>",
    });
    expect(draft.project).toBeUndefined();
    expect(draft.issueType).toBeUndefined();
    expect(draft.reporter).toBeUndefined();
    expect(draft.labels).toEqual(["a-b"]);
    expect(draft).not.toHaveProperty("evil");
    expect(draft.assignee).toEqual(full.assignee);
  });
  it("returns an empty draft for non-objects", () => {
    expect(sanitizeDraft(null)).toEqual({});
    expect(sanitizeDraft("x")).toEqual({});
  });
});
