import { MessageSquarePlus, X } from "lucide-react";
import type { SpecialGroupSession } from "../../../shared/special-group/types";

// This page's own chat sessions (separate from the main chat's conversations).

export function SessionList(props: {
  sessions: SpecialGroupSession[]; activeId: string; busyId: string | null;
  onSelect: (id: string) => void; onCreate: () => void; onDelete: (id: string) => void;
}) {
  return <nav className="sg-sessions" aria-label="Special Group sessions">
    <button type="button" className="secondary-button sg-new-session" onClick={props.onCreate}><MessageSquarePlus size={15} /> New session</button>
    <ul>
      {props.sessions.map(session => <li key={session.id} className={session.id === props.activeId ? "active" : ""}>
        <button type="button" className="sg-session-main" aria-current={session.id === props.activeId ? "true" : undefined} onClick={() => props.onSelect(session.id)}>
          <span>{session.title}</span>
          <small>{session.draft.summary ? "Draft ready" : `${session.messages.length} messages`}{session.id === props.busyId ? " · working" : ""}</small>
        </button>
        <button type="button" className="sg-session-delete" aria-label={`Delete ${session.title}`} disabled={session.id === props.busyId}
          onClick={() => props.onDelete(session.id)}><X size={13} /></button>
      </li>)}
    </ul>
  </nav>;
}
