import {
  Braces,
  Bug,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  Radio,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ChatMessageDebug } from "../../shared/contracts";

const MAX_PREVIEW_STRING = 1_400;
const MAX_PREVIEW_ARRAY = 12;

export function shortenDebugValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_PREVIEW_STRING) {
    const side = Math.floor((MAX_PREVIEW_STRING - 100) / 2);
    return `${value.slice(0, side)}\n… ${value.length - side * 2} characters omitted from the middle …\n${value.slice(-side)}`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_PREVIEW_ARRAY) {
      const head = value.slice(0, 6).map(shortenDebugValue);
      const tail = value.slice(-5).map(shortenDebugValue);
      return [...head, `… ${value.length - 11} items omitted from the middle …`, ...tail];
    }
    return value.map(shortenDebugValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, shortenDebugValue(entry)]),
    );
  }
  return value;
}

function JsonPreview({ value }: { value: unknown }) {
  const preview = useMemo(() => JSON.stringify(shortenDebugValue(value), null, 2), [value]);
  return <pre className="debug-json">{preview}</pre>;
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function MessageDebugBubble({ debug }: { debug: ChatMessageDebug }) {
  const [copied, setCopied] = useState(false);
  const duration = debug.timing.clientDurationMs ?? debug.response.done?.durationMs;
  const firstToken = debug.timing.clientTimeToFirstDeltaMs ?? debug.response.done?.timeToFirstTokenMs;
  const totalTokens = numberFrom(debug.response.done?.usage?.totalTokenCount);

  async function copyTrace() {
    await navigator.clipboard.writeText(JSON.stringify(debug, null, 2));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  }

  return (
    <details className="debug-bubble">
      <summary>
        <span className="debug-summary-icon"><Bug size={14} /></span>
        <span className="debug-summary-title">Debug trace</span>
        <span className={`debug-status debug-status-${debug.response.status}`}>{debug.response.status}</span>
        {typeof duration === "number" ? <span className="debug-summary-metric"><Clock3 size={12} />{duration.toLocaleString()} ms</span> : null}
        <ChevronDown className="debug-chevron" size={15} />
      </summary>

      <div className="debug-panel">
        <div className="debug-panel-head">
          <div>
            <strong>Message exchange</strong>
            <span>Exact local trace · secrets are redacted</span>
          </div>
          <button className="debug-copy" onClick={() => void copyTrace()} aria-label="Copy full debug JSON">
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy JSON"}
          </button>
        </div>

        <div className="debug-metrics">
          <div><span>HTTP</span><strong>{debug.response.http?.status ?? "—"}</strong></div>
          <div><span>First delta</span><strong>{typeof firstToken === "number" ? `${firstToken.toLocaleString()} ms` : "—"}</strong></div>
          <div><span>Delta events</span><strong>{debug.response.deltaEvents.toLocaleString()}</strong></div>
          <div><span>Characters</span><strong>{debug.response.receivedCharacters.toLocaleString()}</strong></div>
          <div><span>Total tokens</span><strong>{totalTokens?.toLocaleString() ?? "—"}</strong></div>
        </div>

        <section className="debug-section">
          <div className="debug-section-title"><Braces size={14} /><strong>Request</strong><span>browser → server → provider</span></div>
          <JsonPreview value={debug.request} />
        </section>

        <section className="debug-section">
          <div className="debug-section-title"><Radio size={14} /><strong>Response</strong><span>HTTP + normalized SSE</span></div>
          <JsonPreview value={{ response: debug.response, timing: debug.timing }} />
        </section>

        <p className="debug-note">
          Long strings and arrays are shortened in the middle in this preview. Copy JSON keeps the full stored trace.
        </p>
      </div>
    </details>
  );
}

