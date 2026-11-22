// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageDebug } from "../../shared/contracts";
import { MessageDebugBubble, shortenDebugValue } from "./MessageDebugBubble";

afterEach(cleanup);

function debugTrace(): ChatMessageDebug {
  return {
    version: 1,
    request: {
      local: {
        method: "POST",
        url: "/api/chat/stream",
        headers: { "Content-Type": "application/json" },
        body: { messages: [{ role: "user", content: "hello" }] },
      },
      provider: {
        method: "POST",
        url: "https://example.test/models/gemini:streamGenerateContent",
        headers: { "x-goog-api-key": "[REDACTED]" },
        body: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
      },
    },
    response: {
      status: "complete",
      http: { status: 200, statusText: "OK", headers: { "content-type": "text/event-stream" } },
      content: "Hello back",
      deltaEvents: 2,
      receivedCharacters: 10,
      done: { finishReason: "STOP", usage: { totalTokenCount: 9 } },
    },
    timing: {
      clientStartedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:00.120Z",
      clientDurationMs: 120,
      clientTimeToFirstDeltaMs: 45,
    },
  };
}

describe("message debug bubble", () => {
  it("is closed by default and exposes compact exchange metrics", () => {
    const { container } = render(<MessageDebugBubble debug={debugTrace()} />);
    const details = container.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Debug trace")).toBeInTheDocument();
    expect(screen.getByText("120 ms")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Debug trace"));
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("Total tokens")).toBeInTheDocument();
    expect(screen.getByText("Copy JSON")).toBeInTheDocument();
  });

  it("cuts long strings and arrays in the middle for display", () => {
    const shortenedString = shortenDebugValue(`start-${"x".repeat(2_000)}-end`);
    expect(shortenedString).toContain("characters omitted from the middle");
    expect(shortenedString).toMatch(/^start-/);
    expect(shortenedString).toMatch(/-end$/);

    const shortenedArray = shortenDebugValue(Array.from({ length: 20 }, (_, index) => index)) as unknown[];
    expect(shortenedArray).toHaveLength(12);
    expect(shortenedArray[6]).toContain("items omitted from the middle");
    expect(shortenedArray.at(-1)).toBe(19);
  });

  it("surfaces explicit cache-hit evidence", () => {
    const debug = debugTrace();
    debug.request.provider!.body = { cachedContent: "projects/p/locations/global/cachedContents/cache-1" };
    debug.response.done!.usage = { totalTokenCount: 5_020, cachedContentTokenCount: 5_000 };
    render(<MessageDebugBubble debug={debug} />);
    expect(screen.getByText("explicit · 5,000")).toBeInTheDocument();
    expect(screen.getByText("Cache hit · explicit")).toBeInTheDocument();
    expect(screen.getByText("5,000 tokens")).toBeInTheDocument();
  });

  it("labels a missing cachedContentTokenCount as an implicit miss", () => {
    render(<MessageDebugBubble debug={debugTrace()} />);
    expect(screen.getByText("no cache hit")).toBeInTheDocument();
    expect(screen.getByText("No implicit cache hit")).toBeInTheDocument();
    expect(screen.getByText("cachedContentTokenCount missing")).toBeInTheDocument();
  });

  it("surfaces implicit cache-hit evidence without a cachedContent resource", () => {
    const debug = debugTrace();
    debug.response.done!.usage = { totalTokenCount: 5_020, cachedContentTokenCount: 4_800 };
    render(<MessageDebugBubble debug={debug} />);
    expect(screen.getByText("implicit · 4,800")).toBeInTheDocument();
    expect(screen.getByText("Cache hit · implicit")).toBeInTheDocument();
  });

  it("shows the requests and tokens of a whole question on large files, per model", () => {
    const usage = {
      requests: 7, inputTokens: 48_200, cachedInputTokens: 6_000, outputTokens: 1_320, thoughtTokens: 0,
      byModel: {
        "gemini-3.8-flash": { requests: 3, inputTokens: 20_000, cachedInputTokens: 6_000, outputTokens: 900, thoughtTokens: 0 },
        "gemini-3.8-flash-lite": { requests: 4, inputTokens: 28_200, cachedInputTokens: 0, outputTokens: 420, thoughtTokens: 0 },
      },
    };
    render(<MessageDebugBubble debug={debugTrace()} largeFileUsage={usage} />);
    expect(screen.getByText("Large files · whole question")).toBeInTheDocument();
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "ModelRequestsInput tokensCachedOutput tokens",
      "All models748,2006,0001,320",
      "gemini-3.8-flash320,0006,000900",
      "gemini-3.8-flash-lite428,2000420",
    ]);
  });

  it("names the one model of a question in place of a total", () => {
    const totals = { requests: 2, inputTokens: 4_400, cachedInputTokens: 0, outputTokens: 36, thoughtTokens: 0 };
    render(<MessageDebugBubble debug={debugTrace()} largeFileUsage={{ ...totals, byModel: { "gemini-3.8-flash": totals } }} />);
    expect(screen.getAllByRole("row").map((row) => row.textContent)).toEqual([
      "ModelRequestsInput tokensCachedOutput tokens",
      "gemini-3.8-flash24,400036",
    ]);
  });

  it("shows no large-file totals without them", () => {
    render(<MessageDebugBubble debug={debugTrace()} />);
    expect(screen.queryByText("Large files · whole question")).not.toBeInTheDocument();
  });
});
