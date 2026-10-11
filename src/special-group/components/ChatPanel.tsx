import { useEffect, useRef, useState, type FormEvent } from "react";
import { Send, Ticket } from "lucide-react";
import { Link } from "react-router-dom";
import type { SpecialGroupMessage } from "../../../shared/special-group/types";
import { MarkdownMessage } from "../../components/MarkdownMessage";
import { LinkActions } from "./LinkActions";

// The conversation. Assistant answers that changed the draft carry their own "Open in Jira" link.

const STARTERS = [
  "The booking page crashes on Safari when I pick a date",
  "Create a story: managers can export weekly room usage to CSV",
  "Which epics are open right now?",
];

export function ChatPanel(props: {
  messages: SpecialGroupMessage[]; busy: boolean; canSend: boolean; modelLabel: string;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [props.messages, props.busy]);

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim() || props.busy || !props.canSend) return;
    props.onSend(draft.trim());
    setDraft("");
  }

  return <section className="sg-chat" aria-label="Special Group chat">
    <div className="sg-panel-heading"><div><h2>Ticket assistant</h2><small>{props.modelLabel} · <Link to="/settings">Model settings</Link></small></div></div>
    <div className="sg-messages" ref={list} aria-live="polite">
      {!props.messages.length && <div className="sg-welcome">
        <span className="sg-welcome-icon"><Ticket size={26} /></span>
        <h3>Describe what you need</h3>
        <p>I'll ask what's missing, look up the right project, epic, and people in Jira, and prepare a ticket you open in Jira with one click.</p>
        {STARTERS.map(text => <button key={text} type="button" onClick={() => setDraft(text)}>{text} <span>↗</span></button>)}
      </div>}
      {props.messages.map(message => <article key={message.id} className={`sg-message sg-message-${message.role}${message.error ? " sg-message-error" : ""}`}>
        <span className="sg-message-author">{message.role === "user" ? "You" : "Assistant"}</span>
        <MarkdownMessage>{message.content}</MarkdownMessage>
        {message.link && <LinkActions link={message.link} compact />}
        {!!message.lookups?.length && <details className="sg-activity"><summary>{message.lookups.length} Jira {message.lookups.length === 1 ? "lookup" : "lookups"}</summary>
          {message.lookups.map((lookup, i) => <div key={i}><strong>{lookup.ok ? "✓" : "!"} {lookup.tool}</strong>
            <pre>{JSON.stringify({ args: lookup.args, result: lookup.result }, null, 2)}</pre></div>)}
        </details>}
      </article>)}
      {props.busy && <p className="sg-working" role="status">Looking things up…</p>}
    </div>
    <form className="sg-composer" onSubmit={submit}>
      <textarea aria-label="Message the ticket assistant" rows={3} maxLength={10000} value={draft} disabled={props.busy}
        placeholder={props.canSend ? "Describe the bug, request, or idea…" : "Connect Jira to start…"}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
      <div><small>Read-only: nothing is created until you press Create in Jira.</small>
        <button className="primary-button" disabled={props.busy || !draft.trim() || !props.canSend}><Send size={15} /> Send</button></div>
    </form>
  </section>;
}
