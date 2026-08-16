import {
  Braces,
  Bug,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  DatabaseZap,
  Radio,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ChatMessageDebug } from "../../shared/contracts";
import { compactDebugValue } from "../../shared/debug";

const MAX_PREVIEW_STRING = 1_400;
const MAX_PREVIEW_ARRAY = 12;

export function shortenDebugValue(value: unknown): unknown {
  return compactDebugValue(value, {
    maxStringCharacters: MAX_PREVIEW_STRING,
    maxArrayItems: MAX_PREVIEW_ARRAY,
  });
}

function JsonPreview({ value }: { value: unknown }) {
  const preview = useMemo(() => JSON.stringify(shortenDebugValue(value), null, 2), [value]);
  return <pre className="debug-json">{preview}</pre>;
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function MessageDebugBubble({ debug }: { debug: ChatMessageDebug }) {
  const [copied, setCopied] = useState(false);
  const duration = debug.timing.clientDurationMs ?? debug.response.done?.durationMs;
  const firstToken = debug.timing.clientTimeToFirstDeltaMs ?? debug.response.done?.timeToFirstTokenMs;
  const usage = debug.response.done?.usage;
  const totalTokens = numberFrom(usage?.totalTokenCount);
  const cachedTokens = numberFrom(usage?.cachedContentTokenCount) ?? 0;
  const providerBody = recordFrom(debug.request.provider?.body);
  const cachedContent = typeof providerBody?.cachedContent === "string" ? providerBody.cachedContent : null;
  const cacheHit = cachedTokens > 0;
  const cacheTitle = cacheHit
    ? `Cache hit${cachedContent ? " · explicit" : " · implicit"}`
    : cachedContent
      ? "Cache miss · explicit"
      : "No implicit cache hit";
  const cacheLabel = cacheHit
    ? `${cachedTokens.toLocaleString()} tokens`
    : cachedContent
      ? "requested · no cachedContentTokenCount"
      : "cachedContentTokenCount missing";
  const cacheSummary = cacheHit
    ? `${cachedContent ? "explicit" : "implicit"} · ${cachedTokens.toLocaleString()}`
    : "no cache hit";

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
        <span className={`debug-summary-cache${cacheHit ? " debug-summary-cache-hit" : ""}`}>{cacheSummary}</span>
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

        <div className="debug-cache-row">
          <span className={`debug-cache-icon${cacheHit ? " debug-cache-icon-hit" : ""}`}><DatabaseZap size={15} /></span>
          <div><strong>{cacheTitle}</strong><span>{cacheLabel}</span></div>
          {cachedContent ? <code title={cachedContent}>{cachedContent}</code> : null}
        </div>

        <div className="debug-metrics">
          <div><span>HTTP</span><strong>{debug.response.http?.status ?? "—"}</strong></div>
          <div><span>First delta</span><strong>{typeof firstToken === "number" ? `${firstToken.toLocaleString()} ms` : "—"}</strong></div>
          <div><span>Delta events</span><strong>{debug.response.deltaEvents.toLocaleString()}</strong></div>
          <div><span>Characters</span><strong>{debug.response.receivedCharacters.toLocaleString()}</strong></div>
          <div><span>Total tokens</span><strong>{totalTokens?.toLocaleString() ?? "—"}</strong></div>
          <div><span>Cached tokens</span><strong>{cachedTokens > 0 ? cachedTokens.toLocaleString() : "—"}</strong></div>
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
          Long strings and arrays are shortened in the middle in this preview. Copy JSON keeps the stored trace; large file contents are compacted before storage.
        </p>
      </div>
    </details>
  );
}
