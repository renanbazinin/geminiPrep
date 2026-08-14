// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("Cache hit · explicit")).toBeInTheDocument();
    expect(screen.getByText("5,000 tokens")).toBeInTheDocument();
  });
});
