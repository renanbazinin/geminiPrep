import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { githubCommitUrl, resolveAppVersion } from "./version.js";

const readVersion = (file: string) => (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
const packageVersion = readVersion("package.json");
const largeFilesVersion = readVersion("node_modules/llm-large-files/package.json");
const slotdeckVersion = readVersion("node_modules/slotdeck/package.json");
const slotdeck = { name: "slotdeck", version: slotdeckVersion };

describe("app version", () => {
  it("reports the commit and the time that the deploy script sets, and the installed packages it names", () => {
    expect(resolveAppVersion({ APP_COMMIT: "b6d9e99", APP_DEPLOYED_AT: "2026-11-12T10:54:08Z" })).toEqual({
      version: packageVersion,
      commit: "b6d9e99",
      commitUrl: "https://github.com/renanbazinin/geminiPrep/commit/b6d9e99",
      deployedAt: "2026-11-12T10:54:08.000Z",
      libraries: [{ name: "llm-large-files", version: largeFilesVersion }, slotdeck],
    });
    expect(largeFilesVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(slotdeckVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("names llm-large-files only while the npm engine runs, and slotdeck always", () => {
    expect(resolveAppVersion({ LARGE_FILES_ENGINE: "npm" }).libraries).toEqual([{ name: "llm-large-files", version: largeFilesVersion }, slotdeck]);
    expect(resolveAppVersion({ LARGE_FILES_ENGINE: "original" }).libraries).toEqual([slotdeck]);
  });

  it("links a dirty deploy to its commit and ignores values that are not a commit or a time", () => {
    expect(resolveAppVersion({ APP_COMMIT: "b6d9e99-dirty" })).toMatchObject({
      commit: "b6d9e99-dirty",
      commitUrl: "https://github.com/renanbazinin/geminiPrep/commit/b6d9e99",
    });
    const odd = resolveAppVersion({ APP_COMMIT: "<b>main</b>", APP_DEPLOYED_AT: "yesterday" });
    // A bad APP_COMMIT falls back to the checkout's own commit, as a local run does.
    expect(odd.commit).not.toBe("<b>main</b>");
    expect(odd.deployedAt).toBeUndefined();
  });

  it("reads the GitHub repository URLs that package.json allows", () => {
    expect(githubCommitUrl("git+https://github.com/owner/repo.git", "abc1234")).toBe("https://github.com/owner/repo/commit/abc1234");
    expect(githubCommitUrl("git@github.com:owner/repo.git", "abc1234")).toBe("https://github.com/owner/repo/commit/abc1234");
    expect(githubCommitUrl("https://github.com/owner/repo", "abc1234-dirty")).toBe("https://github.com/owner/repo/commit/abc1234");
    expect(githubCommitUrl("https://gitlab.com/owner/repo", "abc1234")).toBeUndefined();
    expect(githubCommitUrl(undefined, "abc1234")).toBeUndefined();
  });
});
