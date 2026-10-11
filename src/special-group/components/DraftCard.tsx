import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { buildCreateLink, normalizeLabel } from "../../../shared/special-group/create-link";
import type { Named, ProjectOptions, ProjectSummary, TicketDraft } from "../../../shared/special-group/types";
import { LinkActions } from "./LinkActions";
import { PersonPicker } from "./PersonPicker";

// The editable ticket draft. The assistant fills it; the person can change any field.
// The Jira link is rebuilt from the draft on every render, so it always matches what's shown.

type Props = {
  draft: TicketDraft;
  siteUrl: string;
  projects: ProjectSummary[];
  options: ProjectOptions | null;
  optionsLoading: boolean;
  optionsError: string;
  disabled: boolean;
  onChange: (draft: TicketDraft) => void;
  onReloadOptions: () => void;
};

const parseLabels = (text: string) => [...new Set(text.split(",").map(normalizeLabel).filter(Boolean))];

function toggle(list: Named[] | undefined, item: Named): Named[] | undefined {
  const next = list?.some(i => i.id === item.id) ? list.filter(i => i.id !== item.id) : [...(list ?? []), item];
  return next.length ? next : undefined;
}

export function DraftCard({ draft, siteUrl, projects, options, optionsLoading, optionsError, disabled, onChange, onReloadOptions }: Props) {
  const set = <K extends keyof TicketDraft>(key: K, value: TicketDraft[K]) => {
    const next = { ...draft, [key]: value };
    if (value === undefined || value === "") delete next[key];
    onChange(next);
  };
  // Labels are typed as free text; keep the raw text so a trailing comma doesn't vanish mid-typing.
  const [labelsText, setLabelsText] = useState((draft.labels ?? []).join(", "));
  useEffect(() => {
    if (parseLabels(labelsText).join(",") !== (draft.labels ?? []).join(",")) setLabelsText((draft.labels ?? []).join(", "));
  }, [draft.labels]);

  function chooseProject(key: string) {
    const project = projects.find(p => p.key === key);
    // Work type, parent, components, and versions belong to a project; reset them on change.
    const { issueType: _t, parent: _p, components: _c, fixVersions: _v, project: _old, ...rest } = draft;
    onChange(project ? { ...rest, project: { id: project.id, key: project.key, name: project.name } } : rest);
  }

  const projectChoices = draft.project && !projects.some(p => p.key === draft.project!.key) ? [draft.project, ...projects] : projects;
  const link = buildCreateLink(siteUrl, draft, options?.parentParam ?? null);
  const byId = (list: Named[], id: string) => list.find(item => item.id === id);

  return <section className="sg-draft" aria-label="Ticket draft">
    <div className="sg-panel-heading"><div><h2>Ticket draft</h2><small>Read from Jira · created only when you press Create in Jira</small></div>
      <div className="sg-heading-actions">
        <button type="button" className="icon-button" aria-label="Reload project options" disabled={!draft.project || optionsLoading} onClick={onReloadOptions}>
          <RefreshCw size={16} className={optionsLoading ? "sg-spin" : ""} /></button>
        <button type="button" className="secondary-button" disabled={disabled || !Object.keys(draft).length} onClick={() => onChange({})}>Clear</button>
      </div></div>
    <div className="sg-draft-body">
      {optionsError && <p className="sg-error" role="alert">{optionsError}</p>}
      <div className="sg-grid">
        <label className="sg-field">Project
          <select value={draft.project?.key ?? ""} disabled={disabled} onChange={e => chooseProject(e.target.value)}>
            <option value="">Choose…</option>
            {projectChoices.map(p => <option key={p.key} value={p.key}>{p.name} ({p.key})</option>)}
          </select></label>
        <label className="sg-field">Work type
          <select value={draft.issueType?.id ?? ""} disabled={disabled || !options} onChange={e => set("issueType", byId(options?.issueTypes ?? [], e.target.value))}>
            <option value="">{options ? "Choose…" : "Pick a project"}</option>
            {options?.issueTypes.filter(t => !t.subtask).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
      </div>
      <label className="sg-field">Summary
        <input value={draft.summary ?? ""} maxLength={255} disabled={disabled} onChange={e => set("summary", e.target.value)} placeholder="Short, specific title" /></label>
      <label className="sg-field">Description
        <textarea value={draft.description ?? ""} rows={8} disabled={disabled} onChange={e => set("description", e.target.value)} placeholder="Context, steps, expected result, acceptance criteria…" /></label>
      <div className="sg-grid">
        <label className="sg-field">Epic / parent
          <select value={draft.parent?.key ?? ""} disabled={disabled || !options} onChange={e => {
            const epic = options?.epics.find(x => x.key === e.target.value);
            set("parent", epic ? { key: epic.key, summary: epic.summary } : undefined);
          }}>
            <option value="">None</option>
            {draft.parent && !options?.epics.some(e => e.key === draft.parent!.key) && <option value={draft.parent.key}>{draft.parent.key} {draft.parent.summary ?? ""}</option>}
            {options?.epics.map(e => <option key={e.key} value={e.key}>{e.key} · {e.summary}</option>)}
          </select></label>
        <label className="sg-field">Priority
          <select value={draft.priority?.id ?? ""} disabled={disabled || !options} onChange={e => set("priority", byId(options?.priorities ?? [], e.target.value))}>
            <option value="">Default</option>
            {options?.priorities.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
      </div>
      <div className="sg-grid">
        <PersonPicker label="Reporter" value={draft.reporter} disabled={disabled} onChange={p => set("reporter", p)} />
        <PersonPicker label="Assignee" value={draft.assignee} disabled={disabled} onChange={p => set("assignee", p)} />
      </div>
      <label className="sg-field">Labels <small>comma-separated</small>
        <input value={labelsText} disabled={disabled} onChange={e => { setLabelsText(e.target.value); const labels = parseLabels(e.target.value); set("labels", labels.length ? labels : undefined); }} /></label>
      {!!options?.components.length && <fieldset className="sg-chips"><legend>Components</legend>
        {options.components.map(c => <button type="button" key={c.id} disabled={disabled} aria-pressed={Boolean(draft.components?.some(x => x.id === c.id))}
          onClick={() => set("components", toggle(draft.components, c))}>{c.name}</button>)}</fieldset>}
      {!!options?.versions.length && <fieldset className="sg-chips"><legend>Fix versions</legend>
        {options.versions.map(v => <button type="button" key={v.id} disabled={disabled} aria-pressed={Boolean(draft.fixVersions?.some(x => x.id === v.id))}
          onClick={() => set("fixVersions", toggle(draft.fixVersions, v))}>{v.name}</button>)}</fieldset>}
    </div>
    <div className="sg-draft-footer"><LinkActions link={link} /></div>
  </section>;
}
