import { useState, type FormEvent } from "react";
import { ExternalLink } from "lucide-react";
import { specialGroupApi } from "../api";

// Paste a read-only Jira token. The server verifies it, then saves it to .env.special-group.local
// (Git-ignored). The token is never stored in the browser or sent to the model.

export function ConnectPanel(props: { siteUrl: string; onConnected: () => void }) {
  const [siteUrl, setSiteUrl] = useState(props.siteUrl);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [scoped, setScoped] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setDone("");
    try {
      const result = await specialGroupApi.connect({ siteUrl: siteUrl.trim(), email: email.trim(), token: token.trim(), scoped });
      setToken("");
      setDone(`Connected${result.account ? ` as ${result.account}` : ""}. ${result.projects} project${result.projects === 1 ? "" : "s"} visible.`);
      props.onConnected();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't connect."); }
    finally { setBusy(false); }
  }

  return <form className="sg-connect" onSubmit={submit}>
    <div className="sg-connect-intro">
      <h2>Connect a read-only Jira token</h2>
      <p>Create a scoped token with only <code>read:jira-work</code> and <code>read:jira-user</code>. This app reads Jira and never writes to it.</p>
      <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">Create an Atlassian API token <ExternalLink size={12} /></a>
    </div>
    <label>Jira site<input value={siteUrl} onChange={e => setSiteUrl(e.target.value)} placeholder="https://your-site.atlassian.net" required /></label>
    <label>Atlassian email<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required /></label>
    <label>API token<input type="password" value={token} onChange={e => setToken(e.target.value)} autoComplete="off" placeholder="Paste the token" required /></label>
    <label className="sg-checkbox"><input type="checkbox" checked={scoped} onChange={e => setScoped(e.target.checked)} /> Token created with scopes</label>
    <button className="primary-button" disabled={busy}>{busy ? "Checking…" : "Verify and save"}</button>
    {error && <p className="sg-error" role="alert">{error}</p>}
    {done && <p className="sg-success" role="status">{done}</p>}
  </form>;
}
