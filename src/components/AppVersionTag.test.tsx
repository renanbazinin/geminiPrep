// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppVersion } from "../../shared/contracts";
import { AppVersionTag } from "./AppVersionTag";

const state = vi.hoisted(() => ({ version: undefined as AppVersion | undefined }));
vi.mock("../contexts/ConfigContext", () => ({
  useConfig: () => ({ config: state.version ? { version: state.version } : null, loading: false, error: null, reload() {} }),
}));

afterEach(cleanup);

describe("version tag", () => {
  it("shows the version, links the commit and dates the deploy", () => {
    state.version = {
      version: "1.0.0",
      commit: "b6d9e99",
      commitUrl: "https://github.com/renanbazinin/geminiPrep/commit/b6d9e99",
      deployedAt: "2026-11-12T10:54:08.000Z",
    };
    render(<AppVersionTag />);
    expect(screen.getByText("v1.0.0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "b6d9e99" })).toHaveAttribute("href", "https://github.com/renanbazinin/geminiPrep/commit/b6d9e99");
    expect(document.querySelector("time")).toHaveAttribute("datetime", "2026-11-12T10:54:08.000Z");
  });

  it("names the npm packages in use and links each version on npm", () => {
    state.version = { version: "1.0.0", commit: "abc1234", libraries: [{ name: "llm-large-files", version: "0.5.0" }] };
    render(<AppVersionTag />);
    expect(screen.getByRole("link", { name: "llm-large-files 0.5.0" })).toHaveAttribute("href", "https://www.npmjs.com/package/llm-large-files/v/0.5.0");
    expect(document.querySelector(".version-tag")).toHaveAttribute("title", "Gemini Prep 1.0.0 · commit abc1234 · running locally · llm-large-files 0.5.0");
  });

  it("shows a local run's commit without a link or a date", () => {
    state.version = { version: "1.0.0", commit: "abc1234-dirty" };
    render(<AppVersionTag />);
    expect(screen.getByText("abc1234-dirty")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(document.querySelector("time")).toBeNull();
  });

  it("shows nothing until the server reports a version", () => {
    state.version = undefined;
    const { container } = render(<AppVersionTag />);
    expect(container).toBeEmptyDOMElement();
  });
});
