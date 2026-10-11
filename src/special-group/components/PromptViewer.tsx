import { useEffect, useState } from "react";
import { specialGroupApi } from "../api";

// Shows the assistant's instructions exactly as the server sends them, so behavior isn't a mystery.
// To change them, edit server/special-group/system-prompt.ts.

export function PromptViewer() {
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    specialGroupApi.prompt().then(r => setPrompt(r.prompt)).catch(e => setError(e instanceof Error ? e.message : "Couldn't load the prompt."));
  }, []);
  return <div className="sg-prompt">
    <h2>How the assistant is instructed</h2>
    <p>Edit <code>server/special-group/system-prompt.ts</code> to change it. Live context (site, default project, current draft) is added to each request.</p>
    {error ? <p className="sg-error">{error}</p> : <pre>{prompt || "Loading…"}</pre>}
  </div>;
}
