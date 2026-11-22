import { useState } from "react";
import type { Evidence, NumberRange, ToolOutcome, UsageTotals } from "llm-large-files";
import type { LargeFilesEvent, LargeFilesToolCall } from "../../shared/contracts";

/** What a message gathers from the `largeFiles` events of its answer. */
export type LargeFilesRun = {
  calls: LargeFilesToolCall[];
  notes: string[];
  usage?: UsageTotals;
  /** The tool call each whole-file read request belongs to ("req_4" → "call_2"), to count its retries. */
  requests: Record<string, string>;
};

export const EMPTY_LARGE_FILES_RUN: LargeFilesRun = { calls: [], notes: [], requests: {} };

function withCall(run: LargeFilesRun, callId: string, change: (call: LargeFilesToolCall) => LargeFilesToolCall): LargeFilesRun {
  if (!run.calls.some((call) => call.callId === callId)) return run;
  return { ...run, calls: run.calls.map((call) => (call.callId === callId ? change(call) : call)) };
}

/**
 * Adds one event of the large-file library to what a message shows: its tool calls by `callId`,
 * the notes that are neither a step nor an activity (display "none"), and the question's usage.
 * It returns a new object when anything changed, and the same one otherwise.
 */
export function applyLargeFilesEvent(run: LargeFilesRun, event: LargeFilesEvent): LargeFilesRun {
  switch (event.type) {
    case "tool.start":
      if (run.calls.some((call) => call.callId === event.callId)) return run;
      return {
        ...run,
        calls: [...run.calls, {
          callId: event.callId,
          tool: event.tool,
          label: event.label,
          ...(event.documentId ? { documentId: event.documentId } : {}),
        }],
      };
    case "tool.progress":
      return withCall(run, event.callId, (call) => ({
        ...call,
        progress: { stage: event.stage, done: event.done, total: event.total, message: event.message },
      }));
    case "request.start":
      return event.callId ? { ...run, requests: { ...run.requests, [event.requestId]: event.callId } } : run;
    case "retry": {
      const callId = run.requests[event.requestId];
      return callId ? withCall(run, callId, (call) => ({ ...call, retries: (call.retries ?? 0) + 1 })) : run;
    }
    case "tool.end":
      // A call that ended has no progress left to show (nor to keep in the saved history).
      return withCall(run, event.callId, ({ progress: _progress, ...call }) => ({
        ...call,
        outcome: event.outcome,
        ms: event.ms,
        ...(event.step ? { step: event.step } : {}),
        ...(event.evidence ? { evidence: event.evidence } : {}),
      }));
    case "notice":
      return event.display === "none" && !run.notes.includes(event.message) ? { ...run, notes: [...run.notes, event.message] } : run;
    case "run.finish":
      return { ...run, usage: event.result.usage };
    case "run.error": {
      // A call that started and never ended was ended by the error.
      const calls = run.calls.some((call) => !call.outcome)
        ? run.calls.map(({ progress: _progress, ...call }) => (call.outcome ? call : { ...call, outcome: "error" as const }))
        : run.calls;
      return { ...run, calls, ...(event.partial?.usage ? { usage: event.partial.usage } : {}) };
    }
    default:
      return run;
  }
}

const OUTCOMES: Record<ToolOutcome, { mark: string; label: string }> = {
  ok: { mark: "✓", label: "Done" },
  error: { mark: "✗", label: "Failed" },
  refused: { mark: "–", label: "Refused" },
  not_run: { mark: "–", label: "Not run" },
  already_shown: { mark: "↺", label: "Already shown" },
};

const MAX_RANGES = 5;

function rangesText(singular: string, plural: string, ranges: NumberRange[]): string {
  const shown = ranges.slice(0, MAX_RANGES).map(([from, to]) => (from === to ? from.toLocaleString() : `${from.toLocaleString()}–${to.toLocaleString()}`));
  const single = ranges.length === 1 && ranges[0][0] === ranges[0][1];
  const more = ranges.length > MAX_RANGES ? ` and ${(ranges.length - MAX_RANGES).toLocaleString()} more` : "";
  return `${single ? singular : plural} ${shown.join(", ")}${more}`;
}

/** What a tool call showed the model, in a few words: "lines 11,355–11,360", "pages 2–3". */
export function evidenceText(evidence: Evidence): string {
  const parts = [
    ...(evidence.lines?.length ? [rangesText("line", "lines", evidence.lines)] : []),
    ...(evidence.pages?.length ? [rangesText("page", "pages", evidence.pages)] : []),
  ];
  if (parts.length === 0 && evidence.whole) return "the whole file";
  return parts.join(" · ");
}

/** The steps a list of calls does not already show: the library's step notices, in their order. */
function otherSteps(steps: string[], calls: LargeFilesToolCall[]): string[] {
  const shown = calls.flatMap((call) => (call.step ? [call.step] : []));
  return steps.filter((step) => {
    const index = shown.indexOf(step);
    if (index < 0) return true;
    shown.splice(index, 1);
    return false;
  });
}

function CallItem({ call, streaming }: { call: LargeFilesToolCall; streaming: boolean }) {
  const outcome = call.outcome
    ? OUTCOMES[call.outcome] ?? { mark: "–", label: call.outcome }
    : streaming ? { mark: "…", label: "Running" } : { mark: "–", label: "Not finished" };
  // A step is the label and what came of it: "Search app.log … — 51 matching lines".
  const result = call.step?.startsWith(call.label) ? call.step.slice(call.label.length).replace(/^\s*—\s*/, "") : undefined;
  const progress = call.progress;
  // A bar only while the read goes on; a call that ended, or an answer that stopped, keeps the count as text.
  const reading = Boolean(progress && !call.outcome && streaming);
  const evidence = call.evidence ? evidenceText(call.evidence) : "";
  return (
    <li className={`large-file-call large-file-call-${call.outcome ?? (streaming ? "running" : "open")}`} title={call.step && !result ? call.step : undefined}>
      <span className="large-file-outcome" role="img" aria-label={outcome.label} title={outcome.label}>{outcome.mark}</span>
      <div className="large-file-call-body">
        <div className="large-file-call-head">
          <span className="large-file-label">{call.label}</span>
          {result ? <span className="large-file-result">— {result}</span> : null}
          {call.retries ? <span className="large-file-retries">retried {call.retries}×</span> : null}
          {typeof call.ms === "number" ? <span className="large-file-ms">{call.ms.toLocaleString()} ms</span> : null}
        </div>
        {progress && reading ? (
          <div className="large-file-progress">
            <div
              className="large-file-progress-track"
              role="progressbar"
              aria-label={`Whole-file read: ${call.label}`}
              aria-valuemin={0}
              aria-valuemax={progress.total}
              aria-valuenow={Math.min(progress.done, progress.total)}
              aria-valuetext={progress.message}
            >
              <span style={{ width: `${progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0}%` }} />
            </div>
            <small>{progress.stage === "map" ? "Reading parts" : "Combining notes"}: {progress.done.toLocaleString()} of {progress.total.toLocaleString()}</small>
          </div>
        ) : progress ? (
          <small className="large-file-progress-ended">
            {progress.stage === "map" ? "Parts read" : "Notes combined"}: {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
          </small>
        ) : null}
        {evidence ? <small className="large-file-evidence">Shown: {evidence}</small> : null}
      </div>
    </li>
  );
}

/**
 * The tool calls of the large-file library for one answer (npm engine): each with its label, a
 * progress bar for a whole-file read, its retries, how it ended and what it showed the model;
 * then the steps that were not a call, and the notes. Every string is shown as text. The list is
 * open while the answer streams, so a read's progress and retries are seen as they happen; once the
 * user opens or closes it, their choice is kept.
 */
export function LargeFilesActivity({
  calls,
  notes = [],
  steps = [],
  streaming = false,
}: {
  calls: LargeFilesToolCall[];
  notes?: string[];
  steps?: string[];
  streaming?: boolean;
}) {
  const extra = otherSteps(steps, calls);
  const count = calls.length + extra.length;
  // Undefined until the user toggles the list; until then it follows the answer.
  const [userOpen, setUserOpen] = useState<boolean>();
  const open = userOpen ?? streaming;
  return (
    <>
      {count > 0 ? (
        <details
          className="thinking-summary file-steps large-file-activity"
          open={open}
          // The event also comes when `open` changes here; only a state other than the rendered one is the user's.
          onToggle={(event) => { if (event.currentTarget.open !== open) setUserOpen(event.currentTarget.open); }}
        >
          <summary>Steps on large files ({count})</summary>
          {/* role="list": Safari drops the list semantics of a list styled without markers. */}
          <ol className="large-file-calls" role="list" aria-label="Tool calls on large files">
            {calls.map((call) => <CallItem key={call.callId} call={call} streaming={streaming} />)}
            {extra.map((step, index) => (
              <li className="large-file-call large-file-call-note" key={`step-${index}`}>
                <span className="large-file-outcome" aria-hidden="true">·</span>
                <div className="large-file-call-body"><span className="large-file-label">{step}</span></div>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {notes.length ? (
        <ul className="large-file-notes" aria-label="Notes on large files">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
    </>
  );
}
