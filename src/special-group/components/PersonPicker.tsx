import { useEffect, useState } from "react";
import { X } from "lucide-react";
import type { JiraPerson } from "../../../shared/special-group/types";
import { specialGroupApi } from "../api";

// Type a name, pick a Jira user. Searches after a short pause so each keystroke isn't a request.

export function PersonPicker(props: { label: string; value?: JiraPerson; disabled?: boolean; onChange: (person?: JiraPerson) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JiraPerson[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    let live = true;
    const timer = setTimeout(() => {
      specialGroupApi.people(query).then(r => { if (live) { setResults(r.people); setError(""); } })
        .catch(e => { if (live) setError(e instanceof Error ? e.message : "Search failed."); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  if (props.value) {
    return <div className="sg-field"><span>{props.label}</span>
      <div className="sg-person-chip">{props.value.displayName}
        <button type="button" aria-label={`Clear ${props.label}`} disabled={props.disabled} onClick={() => props.onChange(undefined)}><X size={12} /></button>
      </div></div>;
  }
  return <div className="sg-field"><label>{props.label}
    <input value={query} disabled={props.disabled} placeholder="Search by name" onChange={e => setQuery(e.target.value)} /></label>
    {results.length > 0 && <div className="sg-person-results" role="listbox" aria-label={`${props.label} results`}>
      {results.map(person => <button type="button" role="option" aria-selected="false" key={person.accountId}
        onClick={() => { props.onChange(person); setQuery(""); setResults([]); }}>{person.displayName}</button>)}
    </div>}
    {error && <small className="sg-error">{error}</small>}
  </div>;
}
