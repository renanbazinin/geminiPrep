import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import type { CreateLink } from "../../../shared/special-group/types";

// "Open in Jira" + "Copy link", plus what's missing. Used under chat answers and in the draft card.

export function LinkActions(props: { link: CreateLink; compact?: boolean }) {
  const { url, missing, warnings } = props.link;
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* Clipboard can be blocked; the link is still clickable. */ }
  }
  return <div className={`sg-link${props.compact ? " sg-link-compact" : ""}`}>
    <div className="sg-link-buttons">
      {url
        ? <a className="primary-button" href={url} target="_blank" rel="noreferrer">Open in Jira <ExternalLink size={14} /></a>
        : <span className="primary-button sg-disabled" aria-disabled="true">Open in Jira <ExternalLink size={14} /></span>}
      <button type="button" className="secondary-button" disabled={!url} onClick={() => void copy()}>
        {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy link"}
      </button>
    </div>
    {missing.length > 0 && <small className="sg-link-note">Missing: {missing.join(", ")}</small>}
    {warnings.map(w => <small key={w} className="sg-link-note sg-warn">{w}</small>)}
  </div>;
}
