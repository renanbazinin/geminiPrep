// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { LargeFilesEvent, LargeFilesToolCall } from "../../shared/contracts";
import { EMPTY_LARGE_FILES_RUN, LargeFilesActivity, applyLargeFilesEvent, evidenceText, type LargeFilesRun } from "./LargeFilesActivity";

afterEach(cleanup);

const base = { runId: "run_1", time: 1 };
let seq = 0;
const stamp = <T extends object>(event: T) => ({ ...event, ...base, seq: ++seq }) as unknown as LargeFilesEvent;

const usage = {
  requests: 5, inputTokens: 12_400, cachedInputTokens: 2_000, outputTokens: 310, thoughtTokens: 0,
  byModel: { "gemini-3.8-flash": { requests: 5, inputTokens: 12_400, cachedInputTokens: 2_000, outputTokens: 310, thoughtTokens: 0 } },
};

/** A question that searches once and reads a whole file once, with one retry of a part read. */
const question: LargeFilesEvent[] = [
  stamp({ type: "run.start", models: { answer: "gemini-3.8-flash" }, documentIds: ["doc_1"] }),
  stamp({ type: "plan", inline: [], searchable: [{ id: "doc_1", name: "app.log", format: "log", estimatedTokens: 900_000 }] }),
  stamp({ type: "request.start", requestId: "req_1", role: "tools", purpose: "turn", model: "gemini-3.8-flash", turn: 1 }),
  stamp({ type: "retry", requestId: "req_1", attempt: 1, delayMs: 500, error: { message: "busy" }, message: "The model did not answer (HTTP 503). Trying again…" }),
  stamp({ type: "request.end", requestId: "req_1", ms: 900, outcome: "ok", toolCalls: 2 }),
  stamp({ type: "tool.start", callId: "call_1", tool: "search_document", args: {}, label: "Search app.log (exact) for “timeout”", documentId: "doc_1", round: 1 }),
  stamp({ type: "tool.start", callId: "call_2", tool: "analyze_whole_document", args: {}, label: "Read all of app.log", documentId: "doc_1", round: 1 }),
  stamp({ type: "request.start", requestId: "req_2", role: "reader", purpose: "part", model: "gemini-3.8-flash", callId: "call_2", detail: "part 1 of 4" }),
  stamp({ type: "retry", requestId: "req_2", attempt: 1, delayMs: 500, error: { message: "busy" }, message: "" }),
  stamp({ type: "retry", requestId: "req_2", attempt: 2, delayMs: 900, error: { message: "busy" }, message: "" }),
  stamp({ type: "request.end", requestId: "req_2", ms: 2_000, outcome: "ok" }),
  stamp({ type: "tool.progress", callId: "call_2", stage: "map", done: 1, total: 4, message: "Reading app.log: part 1 of 4" }),
  stamp({ type: "tool.progress", callId: "call_2", stage: "map", done: 3, total: 4, message: "Reading app.log: part 3 of 4" }),
  stamp({ type: "tool.end", callId: "call_1", outcome: "ok", ms: 12, step: "Search app.log (exact) for “timeout” — 3 matching lines",
    evidence: { tool: "search_document", documentId: "doc_1", lines: [[11_355, 11_360]], callId: "call_1" } }),
  stamp({ type: "notice", code: "budget_reached", message: "No more tools: the question reached its limit of input tokens or requests.", display: "none" }),
  stamp({ type: "notice", code: "writing_answer", message: "Writing the answer…", display: "activity" }),
  stamp({ type: "notice", code: "nudged", message: "The model's first reply was empty: it was asked again", display: "step" }),
];

function runOf(events: LargeFilesEvent[]): LargeFilesRun {
  return events.reduce(applyLargeFilesEvent, EMPTY_LARGE_FILES_RUN);
}

describe("large-file events", () => {
  it("builds the calls by callId: progress, the retries of their own requests only, the outcome", () => {
    const run = runOf(question);
    expect(run.calls).toEqual([
      {
        callId: "call_1", tool: "search_document", label: "Search app.log (exact) for “timeout”", documentId: "doc_1",
        outcome: "ok", ms: 12, step: "Search app.log (exact) for “timeout” — 3 matching lines",
        evidence: { tool: "search_document", documentId: "doc_1", lines: [[11_355, 11_360]], callId: "call_1" },
      },
      {
        callId: "call_2", tool: "analyze_whole_document", label: "Read all of app.log", documentId: "doc_1", retries: 2,
        progress: { stage: "map", done: 3, total: 4, message: "Reading app.log: part 3 of 4" },
      },
    ]);
    // Only the notices that are neither a step nor an activity.
    expect(run.notes).toEqual(["No more tools: the question reached its limit of input tokens or requests."]);
    expect(run.usage).toBeUndefined();
  });

  it("takes the question's usage from run.finish, and from the partial result of run.error", () => {
    const finished = applyLargeFilesEvent(runOf(question), stamp({
      type: "run.finish", result: { answered: true, steps: [], evidence: [], turns: 2, usage },
    }));
    expect(finished.usage).toEqual(usage);
    const failed = applyLargeFilesEvent(runOf(question), stamp({ type: "run.error", error: { message: "Stopped." }, partial: { steps: [], evidence: [], usage } }));
    expect(failed.usage).toEqual(usage);
    // A call that never ended was ended by the error.
    expect(failed.calls.map((call) => call.outcome)).toEqual(["ok", "error"]);
  });

  it("drops a call's progress once it ends, by tool.end or by run.error", () => {
    const reading = runOf(question.slice(0, 13));
    expect(reading.calls[1].progress).toBeDefined();
    const ended = applyLargeFilesEvent(reading, stamp({ type: "tool.end", callId: "call_2", outcome: "error", ms: 900 }));
    expect(ended.calls[1]).not.toHaveProperty("progress");
    expect(ended.calls[1].outcome).toBe("error");
    const failed = applyLargeFilesEvent(reading, stamp({ type: "run.error", error: { message: "Stopped." } }));
    expect(failed.calls[1]).not.toHaveProperty("progress");
    expect(failed.calls[1].outcome).toBe("error");
  });

  it("returns the same object for events that change nothing", () => {
    const run = runOf(question);
    expect(applyLargeFilesEvent(run, stamp({ type: "notice", code: "writing_answer", message: "Writing the answer…", display: "activity" }))).toBe(run);
    expect(applyLargeFilesEvent(run, stamp({ type: "tool.progress", callId: "call_9", stage: "map", done: 1, total: 2, message: "" }))).toBe(run);
  });

  it("writes evidence as lines and pages", () => {
    expect(evidenceText({ tool: "read_document", documentId: "d", lines: [[11_355, 11_360]] })).toBe("lines 11,355–11,360");
    expect(evidenceText({ tool: "view_pages", documentId: "d", pages: [[2, 3]] })).toBe("pages 2–3");
    expect(evidenceText({ tool: "view_pages", documentId: "d", pages: [[7, 7]] })).toBe("page 7");
    expect(evidenceText({ tool: "search_document", documentId: "d", lines: [[1, 1], [5, 5], [9, 9], [20, 22], [40, 40], [50, 50], [60, 60]] }))
      .toBe("lines 1, 5, 9, 20–22, 40 and 2 more");
    expect(evidenceText({ tool: "read_document", documentId: "d", lines: [[10, 20]], pages: [[3, 3]] })).toBe("lines 10–20 · page 3");
    expect(evidenceText({ tool: "analyze_whole_document", documentId: "d", whole: true })).toBe("the whole file");
  });
});

describe("large-file activity", () => {
  const calls: LargeFilesToolCall[] = [
    { callId: "call_1", tool: "search_document", label: "Search app.log (exact) for “<b>timeout</b>”", outcome: "ok", ms: 1_210,
      step: "Search app.log (exact) for “<b>timeout</b>” — 3 matching lines",
      evidence: { tool: "search_document", documentId: "d", lines: [[11_355, 11_360]] } },
    { callId: "call_2", tool: "analyze_whole_document", label: "Read all of app.log", retries: 2,
      progress: { stage: "map", done: 3, total: 12, message: "Reading app.log: part 3 of 12" } },
    { callId: "call_3", tool: "read_document", label: "Read app.log lines 1–40", outcome: "already_shown", ms: 1 },
    { callId: "call_4", tool: "view_pages", label: "Look at report.pdf pages 2–3", outcome: "refused", ms: 0 },
    { callId: "call_5", tool: "read_document", label: "Read app.log lines 900–950", outcome: "error", ms: 3 },
    { callId: "call_6", tool: "read_document", label: "Read app.log lines 2–3", outcome: "not_run", ms: 0 },
  ];

  it("lists each call with its outcome, time, retries, progress and evidence, as text", () => {
    render(<LargeFilesActivity
      calls={calls}
      notes={["No more tools: the question reached its limit of input tokens or requests."]}
      steps={["Search app.log (exact) for “<b>timeout</b>” — 3 matching lines", "The model's first reply was empty: it was asked again"]}
      streaming
    />);
    expect(screen.getByText("Steps on large files (7)")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Tool calls on large files" });
    // Explicit: Safari drops the implicit role of a list styled without markers.
    expect(list).toHaveAttribute("role", "list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(7);
    // The label is text, never HTML.
    expect(within(items[0]).getByText("Search app.log (exact) for “<b>timeout</b>”")).toBeInTheDocument();
    expect(within(items[0]).getByText("— 3 matching lines")).toBeInTheDocument();
    expect(within(items[0]).getByRole("img", { name: "Done" })).toHaveTextContent("✓");
    expect(within(items[0]).getByText("1,210 ms")).toBeInTheDocument();
    expect(within(items[0]).getByText("Shown: lines 11,355–11,360")).toBeInTheDocument();
    expect(within(items[1]).getByRole("img", { name: "Running" })).toBeInTheDocument();
    expect(within(items[1]).getByText("retried 2×")).toBeInTheDocument();
    const bar = within(items[1]).getByRole("progressbar", { name: "Whole-file read: Read all of app.log" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "12");
    expect(bar).toHaveAttribute("aria-valuetext", "Reading app.log: part 3 of 12");
    expect(within(items[1]).getByText("Reading parts: 3 of 12")).toBeInTheDocument();
    expect(within(items[2]).getByRole("img", { name: "Already shown" })).toHaveTextContent("↺");
    expect(within(items[3]).getByRole("img", { name: "Refused" })).toHaveTextContent("–");
    expect(within(items[4]).getByRole("img", { name: "Failed" })).toHaveTextContent("✗");
    expect(within(items[5]).getByRole("img", { name: "Not run" })).toHaveTextContent("–");
    // A step that is not a call's (a notice) is kept.
    expect(within(items[6]).getByText("The model's first reply was empty: it was asked again")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Notes on large files" })).toHaveTextContent("No more tools");
    expect(document.querySelector("b")).toBeNull();
  });

  it("marks a call that never ended once the answer is over, with its count as text and no bar", () => {
    render(<LargeFilesActivity calls={[calls[1]]} />);
    expect(screen.getByRole("img", { name: "Not finished" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Parts read: 3 of 12")).toBeInTheDocument();
  });

  it("shows no bar for a call that has an outcome, even while the answer streams (saved history included)", () => {
    const failed: LargeFilesToolCall = { ...calls[1], outcome: "error", ms: 5 };
    render(<LargeFilesActivity calls={[failed]} streaming />);
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByText("Parts read: 3 of 12")).toBeInTheDocument();
  });

  it("is open while the answer streams, closes after it, and keeps the user's own choice", async () => {
    const details = () => document.querySelector("details")!;
    const { rerender } = render(<LargeFilesActivity calls={[calls[1]]} streaming />);
    expect(details()).toHaveAttribute("open");
    // Progress and retries are visible while the answer streams.
    expect(screen.getByRole("progressbar")).toBeVisible();
    expect(screen.getByText("retried 2×")).toBeVisible();
    rerender(<LargeFilesActivity calls={[calls[1]]} />);
    expect(details()).not.toHaveAttribute("open");

    cleanup();
    const second = render(<LargeFilesActivity calls={[calls[1]]} streaming />);
    // The user closes it while the answer streams: it stays closed.
    await act(async () => {
      details().open = false;
      fireEvent(details(), new Event("toggle"));
    });
    second.rerender(<LargeFilesActivity calls={[calls[1]]} streaming />);
    expect(details()).not.toHaveAttribute("open");
    // Then opens it: it stays open after the answer ended.
    await act(async () => {
      details().open = true;
      fireEvent(details(), new Event("toggle"));
    });
    second.rerender(<LargeFilesActivity calls={[calls[1]]} />);
    expect(details()).toHaveAttribute("open");
  });

  it("shows notes alone when no tool ran", () => {
    render(<LargeFilesActivity calls={[]} notes={["The provider refused the prompt: SAFETY."]} />);
    expect(screen.queryByText(/Steps on large files/)).not.toBeInTheDocument();
    expect(screen.getByText("The provider refused the prompt: SAFETY.")).toBeInTheDocument();
  });
});
