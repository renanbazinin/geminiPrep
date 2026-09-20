import { useEffect, useRef, useState, type FormEvent } from "react";
import { ExternalLink, RefreshCw, Send, Ticket, PlugZap } from "lucide-react";
import { Link } from "react-router-dom";
import { JIRA_TEAM, type JiraAction, type JiraChatResult, type JiraConnection, type JiraIssue } from "../../shared/jira";
import { useApp } from "../contexts/AppContext";
import { MarkdownMessage } from "../components/MarkdownMessage";
import "../jira.css";

type Message = { id: string; role: "user" | "assistant"; content: string; actions?: JiraAction[] };
const STORAGE = "gemini-prep-jira-chat-v1";
async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}
function loadMessages(): Message[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
    return Array.isArray(saved) ? saved.filter(m => m && typeof m.id === "string" && typeof m.content === "string" && ["user", "assistant"].includes(m.role)).slice(-60) : [];
  } catch { return []; }
}

export function JiraPage() {
  const { settings } = useApp();
  const [connection, setConnection] = useState<JiraConnection | null>(null);
  const [issues, setIssues] = useState<JiraIssue[]>([]);
  const [loadedAt, setLoadedAt] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [draft, setDraft] = useState("");
  const [owner, setOwner] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [showConnection, setShowConnection] = useState(false);
  const [email, setEmail] = useState("renabazinin2@gmail.com");
  const [token, setToken] = useState("");
  const [scoped, setScoped] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    try { localStorage.setItem(STORAGE, JSON.stringify(messages.map(({ actions: _actions, ...message }) => message))); } catch { /* Storage can be full. */ }
    const messageList = bottom.current?.parentElement;
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }, [messages, busy]);

  async function refresh() {
    setLoading(true); setError("");
    try {
      const config = await api<JiraConnection>("/api/jira/config");
      if (!mounted.current) return;
      setConnection(config);
      if (!config.configured) { setIssues([]); setLoadedAt(""); setShowConnection(true); return; }
      const result = await api<{ issues: JiraIssue[]; fetchedAt: string; truncated: boolean }>("/api/jira/issues");
      if (!mounted.current) return;
      setIssues(result.issues); setLoadedAt(result.fetchedAt); setTruncated(result.truncated);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not load Jira."); }
    finally { if (mounted.current) setLoading(false); }
  }

  async function connect(event: FormEvent) {
    event.preventDefault(); setConnecting(true); setError("");
    try {
      await api("/api/jira/connect", { email: email.trim(), token: token.trim(), scoped });
      setToken(""); setShowConnection(false); await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not connect."); }
    finally { setConnecting(false); }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!draft.trim() || busy || !connection?.configured || messages.length >= 59) return;
    const next: Message[] = [...messages, { id: crypto.randomUUID(), role: "user", content: draft.trim() }];
    setMessages(next); setDraft(""); setBusy(true); setError("");
    try {
      const result = await api<JiraChatResult>("/api/jira/chat", {
        requestId: crypto.randomUUID(), provider: settings.provider, model: settings.models[settings.provider],
        ...(settings.provider === "vertex" ? { region: settings.region } : {}),
        temperature: settings.temperature, maxOutputTokens: settings.maxOutputTokens,
        thinkingLevel: settings.thinkingLevel, systemInstruction: settings.systemInstruction,
        messages: next.map(({ role, content }) => ({ role, content })),
      });
      if (!mounted.current) return;
      setMessages(current => [...current, { id: crypto.randomUUID(), role: "assistant", content: result.text, actions: result.actions }]);
      await refresh();
    } catch (reason) {
      if (mounted.current) setMessages(current => [...current, { id: crypto.randomUUID(), role: "assistant",
        content: `${reason instanceof Error ? reason.message : "Connection interrupted."}\n\nRefresh the tickets before repeating a change; a request may have completed on Jira.` }]);
    } finally { if (mounted.current) setBusy(false); }
  }

  const visible = issues.filter(issue => (!owner || issue.owner === owner) && (!status || issue.status === status)
    && `${issue.key} ${issue.summary}`.toLowerCase().includes(search.toLowerCase()));
  const statuses = [...new Set(issues.map(issue => issue.status))].sort();
  return <div className="jira-page">
    <header className="jira-header">
      <div><div className="jira-eyebrow"><Ticket size={16} /> YOUR CONNECTED WORKSPACE</div>
        <h1>DeskFlow <span>Jira space</span></h1><p>See your tickets. Ask for a change. Keep work moving.</p></div>
      <div className="jira-header-actions">
        <button className="secondary-button" onClick={() => setShowConnection(!showConnection)}><PlugZap size={16} /> Connection</button>
        <a className="secondary-button" target="_blank" rel="noreferrer" href={`${connection?.siteUrl ?? "https://renanbazinin2.atlassian.net"}/browse/${connection?.projectKey ?? "DESK"}`}>Open Jira <ExternalLink size={14} /></a>
      </div>
    </header>
    <div className="jira-team">{JIRA_TEAM.map(member => <button key={member.name} className={owner === member.name ? "selected" : ""}
      onClick={() => setOwner(owner === member.name ? "" : member.name)} aria-pressed={owner === member.name}>
      <span className="jira-avatar">{member.name[0]}</span><span><strong>{member.name}</strong><small>{member.role}</small></span>
    </button>)}<p>Demo owners use labels.<br />Real Jira assignees remain separate.</p></div>
    {error && <div className="jira-error" role="alert">{error}</div>}
    {(showConnection || connection?.configured === false) && <form className="jira-connection" onSubmit={connect}>
      <div><h2>Connect your Jira account</h2><p>Connect to <strong>renanbazinin2.atlassian.net</strong>. Your token is saved only in the local server’s ignored configuration file.</p>
        <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">Create an Atlassian API token <ExternalLink size={12} /></a></div>
      <label>Atlassian email<input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" /></label>
      <label>API token<input type="password" required value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder="Paste your token here" /></label>
      <label className="jira-checkbox"><input type="checkbox" checked={scoped} onChange={e => setScoped(e.target.checked)} /> Token created with scopes</label>
      <button className="primary-button" disabled={connecting}>{connecting ? "Checking connection…" : "Connect Jira"}</button>
      <small>For scoped tokens, select read:jira-work, write:jira-work, and read:jira-user. Local demo access only.</small>
    </form>}
    <div className="jira-workspace">
      <section className="jira-chat" aria-label="Jira chat">
        <div className="jira-panel-heading"><div><h2>Chat with your project</h2><small>{settings.models[settings.provider]} · <Link to="/settings">Model settings</Link></small></div>
          <button className="secondary-button" disabled={busy} onClick={() => setMessages([])}>New chat</button></div>
        <div className="jira-messages" aria-live="polite">
          {!messages.length && <div className="jira-welcome"><span className="jira-welcome-icon"><Ticket size={28} /></span><h3>What’s happening in DeskFlow?</h3>
            <p>I can read your tickets, create work, change demo owners, update statuses, and add comments.</p>
            {["Show my current tickets", "What is Renan working on?", "What is waiting for QA?", "Summarize project status for Dana"].map(prompt => <button key={prompt} onClick={() => setDraft(prompt)}>{prompt} <span>↗</span></button>)}</div>}
          {messages.map(message => <article key={message.id} className={`jira-message jira-message-${message.role}`}>
            <span className="jira-message-author">{message.role === "user" ? "You" : "DeskFlow assistant"}</span>
            <MarkdownMessage>{message.content}</MarkdownMessage>
            {!!message.actions?.length && <details className="jira-activity"><summary>{message.actions.length} Jira {message.actions.length === 1 ? "action" : "actions"}</summary>{message.actions.map((action, i) =>
              <div key={i}><strong>{action.ok ? "✓" : "!"} {action.tool.replace("jira_", "")}</strong><pre>{JSON.stringify(action.result, null, 2)}</pre></div>)}</details>}
          </article>)}
          {busy && <p className="jira-working" role="status">Working with Jira… Changes may take a moment.</p>}<div ref={bottom} />
        </div>
        <form className="jira-composer" onSubmit={send}><textarea aria-label="Message Jira assistant" placeholder={connection?.configured ? "Ask about tickets, or describe a change…" : "Connect Jira to start chatting…"}
          value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} rows={3} maxLength={10000}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
          <div><small>Changes requested here are saved to Jira.</small><button className="primary-button" disabled={busy || !draft.trim() || !connection?.configured || messages.length >= 59}><Send size={15} /> Send</button></div>
          {messages.length >= 59 && <small>Start a new chat to continue.</small>}
        </form>
      </section>
      <section className="jira-tickets" aria-label="Current Jira tickets">
        <div className="jira-panel-heading"><div><h2>Your tickets <span className="jira-count">{issues.length}</span></h2>
          <small>{loadedAt ? `Fetched ${new Date(loadedAt).toLocaleTimeString()}` : "Waiting for connection"}</small></div>
          <button className="icon-button" aria-label="Refresh tickets" onClick={() => void refresh()} disabled={loading || busy}><RefreshCw size={18} className={loading ? "jira-spin" : ""} /></button></div>
        <div className="jira-ticket-filters"><input aria-label="Search tickets" placeholder="Search ticket or title" value={search} onChange={e => setSearch(e.target.value)} />
          <select aria-label="Filter by status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{statuses.map(s => <option key={s}>{s}</option>)}</select>
          {owner && <button onClick={() => setOwner("")}>{owner} ×</button>}</div>
        <div className="jira-ticket-list">{visible.map(issue => <article className="jira-ticket" key={issue.key}>
          <div className="jira-ticket-top"><a href={issue.url} target="_blank" rel="noreferrer">{issue.key} <ExternalLink size={11} /></a><span className={`jira-status ${issue.status === "Done" ? "done" : issue.status === "In QA" ? "qa" : ""}`}>{issue.status}</span></div>
          <h3>{issue.summary}</h3><div className="jira-ticket-meta"><span>{issue.type}</span><span>{issue.owner ? `${issue.owner} · demo owner` : "No demo owner"}</span></div>
          <details><summary>Details</summary><p>{issue.description || "No description."}</p><small>Jira assignee: {issue.assignee ?? "Unassigned"}</small></details>
          <button className="jira-discuss" disabled={busy} onClick={() => setDraft(`Show details and available actions for ${issue.key}`)}>Discuss in chat ↗</button>
        </article>)}
        {!visible.length && <p className="jira-empty">{loading ? "Loading tickets…" : !connection?.configured ? "Connect Jira above to load your real tickets." : loadedAt ? "No tickets match these filters." : "Refresh to load tickets from Jira."}</p>}
        {truncated && <p className="jira-empty">Showing the first 200 tickets. Ask chat for a narrower search.</p>}</div>
      </section>
    </div>
  </div>;
}
