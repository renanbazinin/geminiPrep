import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CircleCheck,
  Copy,
  Download,
  LoaderCircle,
  MessageSquare,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { PatternDef, SlotDef, StudioShape, StudioSlide } from "slotdeck";
import type {
  DraftProgress,
  ManifestChange,
  ManifestChangeOutcome,
  PatternLayoutShape,
  PresentationTemplateDetail,
} from "../../shared/presentations";
import { chatModelFor } from "../../shared/gemini-4";
import { SlideWireframe } from "../components/SlideWireframe";
import { useApp } from "../contexts/AppContext";
import {
  changeTemplate,
  deleteTemplate,
  draftTemplate,
  duplicateTemplate,
  fetchTemplate,
  fetchTemplates,
  instructTemplate,
  saveTemplateFields,
  templateFileUrl,
} from "../lib/presentations";

type LogLine = { ok: boolean; text: string };

const POLICY_LABELS: Record<string, string> = {
  error: "Required",
  remove: "Optional",
  keep: "Keep the template's own",
  drop: "Always removed",
};

const ROLE_HINTS: Record<string, string> = {
  title: "The slide's heading",
  subtitle: "A second heading",
  text: "A paragraph or a short label",
  list: "One paragraph per item",
  number: "A large figure",
  caption: "A few words under a picture or figure",
  photo: "A photograph to replace",
  icon: "A small pictogram to replace",
  graphic: "A supplied chart or diagram picture",
  chart: "A native, editable chart in place of the picture",
  table: "A table",
  decoration: "Drawn for the sample content: removed from every slide",
};

/** The numbers a slot of each kind can be given, with the words the studio shows for them. */
const LIMITS: Record<SlotDef["kind"], Array<[key: string, label: string]>> = {
  text: [["maxChars", "Characters"], ["maxParagraphs", "Paragraphs"]],
  image: [],
  table: [["maxColumns", "Columns"], ["maxRows", "Rows"], ["maxCellChars", "Characters a cell"]],
  chart: [["maxCategories", "Categories"], ["maxSeries", "Series"]],
};

/** A slide's shapes as the boxes of a layout: the pattern's slots coloured, the rest grey. */
function layoutShapes(slide: StudioSlide, pattern: PatternDef | undefined): PatternLayoutShape[] {
  const shapes: PatternLayoutShape[] = [];
  for (const shape of slide.shapes) {
    if (shape.kind === "group") continue;
    const slot = pattern?.slots.find((candidate) => candidate.shapeId === shape.id);
    if (slot?.empty === "drop") continue;
    const box = (slot && slot.kind !== "table" && slot.box) || shape.box;
    if (shape.kind !== "line" && (box.w <= 0 || box.h <= 0)) continue;
    const size = slot?.kind === "text" ? (slot.fontSize ?? slot.size ?? shape.fontSize) : undefined;
    shapes.push({
      box,
      fill: slot ? slot.kind : shape.kind === "line" ? "line" : "design",
      ...(slot ? { label: slot.name } : {}),
      ...(size !== undefined ? { fontSize: size } : {}),
    });
  }
  return shapes;
}

function NumberField({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  return (
    <label className="studio-field studio-field-number">
      <span>{label}</span>
      <input className="studio-input" inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, ""))} />
    </label>
  );
}

/** What a slide's shape is in the layout, and the controls that change it. */
function ShapeInspector({ shape, pattern, readOnly, busy, apply }: {
  shape: StudioShape;
  pattern: PatternDef;
  readOnly: boolean;
  busy: boolean;
  apply(changes: ManifestChange[]): void;
}) {
  const slot = pattern.slots.find((candidate) => candidate.shapeId === shape.id);
  const [name, setName] = useState(slot?.name ?? "");
  const [limits, setLimits] = useState<Record<string, string>>({});
  useEffect(() => {
    setName(slot?.name ?? "");
    const record = (slot ?? {}) as unknown as Record<string, unknown>;
    setLimits(Object.fromEntries((slot ? LIMITS[slot.kind] : []).map(([key]) => [key, record[key] === undefined ? "" : String(record[key])])));
  }, [slot, shape.id, pattern.id]);

  const changedLimits = slot
    ? LIMITS[slot.kind].filter(([key]) => (limits[key] ?? "") !== "" && Number(limits[key]) !== (slot as unknown as Record<string, unknown>)[key])
    : [];
  const summary = shape.slots.find((entry) => entry.pattern === pattern.id)?.summary;

  return (
    <section className="studio-panel" aria-label="Selected shape">
      <h3>Shape #{shape.id} <small>{shape.kind}{shape.fontSize ? ` · ${shape.fontSize} pt` : ""}</small></h3>
      {shape.text ? <p className="studio-sample" dir="auto">“{shape.text.length > 160 ? `${shape.text.slice(0, 159)}…` : shape.text}”</p> : null}
      {shape.frame ? <p className="studio-hint">Sits in the same place on many slides, so it is probably part of the frame (logo, rule, page number).</p> : null}
      {slot ? (
        <p className="studio-slot-line"><strong>{slot.name}</strong> — {summary ?? slot.kind}</p>
      ) : (
        <p className="studio-hint">Not a slot: it is copied to every deck exactly as designed.</p>
      )}

      {readOnly ? null : (
        <>
          {shape.roles.length > 0 ? (
            <div className="studio-roles" role="group" aria-label={slot ? "Change what it holds" : "Make it a slot"}>
              <span>{slot ? "Change to" : "Make it a slot for"}</span>
              {shape.roles.map((role) => (
                <button
                  key={role}
                  type="button"
                  className="studio-chip-button"
                  title={ROLE_HINTS[role]}
                  disabled={busy}
                  onClick={() => apply([{ op: "addSlot", pattern: pattern.id, shape: shape.id, role }])}
                >
                  {role}
                </button>
              ))}
            </div>
          ) : (
            <p className="studio-hint">A {shape.kind} cannot carry content.</p>
          )}

          {slot ? (
            <>
              <label className="studio-field">
                <span>When a deck gives nothing</span>
                <select
                  className="studio-input"
                  value={slot.empty ?? "error"}
                  disabled={busy}
                  onChange={(event) => apply([{ op: "setSlot", pattern: pattern.id, slot: slot.name, empty: event.target.value as NonNullable<SlotDef["empty"]> }])}
                >
                  {Object.entries(POLICY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <form
                className="studio-inline"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (name.trim() && name.trim() !== slot.name) apply([{ op: "setSlot", pattern: pattern.id, slot: slot.name, name: name.trim() }]);
                }}
              >
                <label className="studio-field">
                  <span>Slot name</span>
                  <input className="studio-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={48} />
                </label>
                <button type="submit" className="secondary-button" disabled={busy || !name.trim() || name.trim() === slot.name}>Rename</button>
              </form>
              {LIMITS[slot.kind].length > 0 ? (
                <form
                  className="studio-inline"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (changedLimits.length === 0) return;
                    apply([{ op: "setSlot", pattern: pattern.id, slot: slot.name, ...Object.fromEntries(changedLimits.map(([key]) => [key, Number(limits[key])])) } as ManifestChange]);
                  }}
                >
                  {LIMITS[slot.kind].map(([key, label]) => (
                    <NumberField key={key} label={label} value={limits[key] ?? ""} onChange={(value) => setLimits((current) => ({ ...current, [key]: value }))} />
                  ))}
                  <button type="submit" className="secondary-button" disabled={busy || changedLimits.length === 0}>Set</button>
                </form>
              ) : null}
              <button type="button" className="text-button" disabled={busy} onClick={() => apply([{ op: "removeSlot", pattern: pattern.id, slot: slot.name }])}>
                Not a slot: keep it as designed
              </button>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

/** A layout's name, purpose and row of items. */
function PatternInspector({ pattern, readOnly, busy, apply }: {
  pattern: PatternDef;
  readOnly: boolean;
  busy: boolean;
  apply(changes: ManifestChange[]): void;
}) {
  const [id, setId] = useState(pattern.id);
  const [description, setDescription] = useState(pattern.description);
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [copyId, setCopyId] = useState("");
  const [armed, setArmed] = useState(false);
  const repeat = pattern.repeat;
  const drawn = repeat?.shapes.length ?? 0;
  useEffect(() => {
    setId(pattern.id);
    setDescription(pattern.description);
    setMin(String(repeat?.min ?? drawn));
    setMax(String(repeat?.max ?? drawn));
    setCopyId("");
    setArmed(false);
  }, [pattern, repeat, drawn]);

  const changed = id.trim() !== pattern.id || description.trim() !== pattern.description;
  function save(event: FormEvent) {
    event.preventDefault();
    if (!changed) return;
    apply([{
      op: "setPattern",
      pattern: pattern.id,
      ...(id.trim() !== pattern.id ? { id: id.trim() } : {}),
      ...(description.trim() !== pattern.description ? { description: description.trim() } : {}),
    }]);
  }

  return (
    <section className="studio-panel" aria-label="Layout">
      <h3>Layout <small>from slide {pattern.sourceSlide}</small></h3>
      {readOnly ? (
        <>
          <p className="studio-slot-line"><strong>{pattern.id}</strong></p>
          <p className="studio-hint" dir="auto">{pattern.description}</p>
          {repeat ? <p className="studio-hint">A {repeat.columns ? "grid" : "row"} of {drawn} {repeat.item}s; a deck may have {repeat.min ?? drawn} to {repeat.max ?? drawn}.</p> : null}
          {pattern.figures ? <p className="studio-hint">Built around numbers: offered only when the brief has figures.</p> : null}
        </>
      ) : (
        <>
          <form className="studio-stack" onSubmit={save}>
            <label className="studio-field">
              <span>Id</span>
              <input className="studio-input" value={id} onChange={(event) => setId(event.target.value)} maxLength={48} />
            </label>
            <label className="studio-field">
              <span>What it is for (the planner reads this)</span>
              <textarea className="studio-input" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} maxLength={400} dir="auto" />
            </label>
            <button type="submit" className="secondary-button" disabled={busy || !changed || !id.trim() || !description.trim()}>Save</button>
          </form>
          <label className="studio-check">
            <input
              type="checkbox"
              checked={pattern.figures === true}
              disabled={busy}
              onChange={(event) => apply([{ op: "setPattern", pattern: pattern.id, figures: event.target.checked }])}
            />
            <span>Built around numbers <small>offered only when the brief has figures, so none are invented</small></span>
          </label>
          {repeat ? (
            <form
              className="studio-inline"
              onSubmit={(event) => {
                event.preventDefault();
                apply([{ op: "setRepeat", pattern: pattern.id, min: Number(min), max: Number(max) }]);
              }}
            >
              <span className="studio-inline-label">{repeat.columns ? "Grid" : "Row"} of {drawn} {repeat.item}s. A deck may have</span>
              <NumberField label="from" value={min} onChange={setMin} />
              <NumberField label="to" value={max} onChange={setMax} />
              <button type="submit" className="secondary-button" disabled={busy || !min || !max}>Set</button>
              <button type="button" className="text-button" disabled={busy} onClick={() => apply([{ op: "removeRepeat", pattern: pattern.id }])}>Fixed number</button>
            </form>
          ) : (
            <button type="button" className="text-button" disabled={busy} onClick={() => apply([{ op: "setRepeat", pattern: pattern.id }])}
              title="Looks for slots numbered alike: card1Heading, card2Heading">
              Find a row of like items, so a deck can choose how many
            </button>
          )}
          <form
            className="studio-inline"
            onSubmit={(event) => {
              event.preventDefault();
              if (copyId.trim()) apply([{ op: "copyPattern", pattern: pattern.id, id: copyId.trim() }]);
            }}
          >
            <label className="studio-field">
              <span>A second layout from this slide</span>
              <input className="studio-input" value={copyId} onChange={(event) => setCopyId(event.target.value)} placeholder={`${pattern.id}-variant`} maxLength={48} />
            </label>
            <button type="submit" className="secondary-button" disabled={busy || !copyId.trim()}><Copy size={14} /> Copy</button>
          </form>
          <button
            type="button"
            className={armed ? "danger-button" : "text-button"}
            disabled={busy}
            onBlur={() => setArmed(false)}
            onClick={() => (armed ? apply([{ op: "removePattern", pattern: pattern.id }]) : setArmed(true))}
          >
            {armed ? "Remove this layout?" : "Remove this layout"}
          </button>
        </>
      )}
    </section>
  );
}

export function TemplateEditor({ id }: { id: string }) {
  const { settings, updateSettings } = useApp();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<PresentationTemplateDetail | null>(null);
  const [defaultTemplate, setDefaultTemplate] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<DraftProgress | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [slideNumber, setSlideNumber] = useState(1);
  const [patternId, setPatternId] = useState<string | null>(null);
  const [shapeId, setShapeId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [newPatternId, setNewPatternId] = useState("");
  const [fieldDraft, setFieldDraft] = useState<Record<string, string>>({});
  const [redraftArmed, setRedraftArmed] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const model = chatModelFor(settings);
  const choice = useMemo(() => ({ provider: settings.provider, model }), [settings.provider, model]);

  useEffect(() => {
    let current = true;
    fetchTemplate(id).then(
      (loaded) => { if (current) setDetail(loaded); },
      (reason) => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    fetchTemplates().then((list) => { if (current) setDefaultTemplate(list.defaultTemplate); }, () => undefined);
    return () => { current = false; };
  }, [id]);

  useEffect(() => {
    if (detail) setFieldDraft(Object.fromEntries(detail.fields.map((field) => [field.name, field.value])));
  }, [detail]);

  const slide = detail?.view.slides.find((candidate) => candidate.slide === slideNumber) ?? detail?.view.slides[0];
  const patterns = useMemo(
    () => (detail && slide ? detail.manifest.patterns.filter((pattern) => pattern.sourceSlide === slide.slide) : []),
    [detail, slide],
  );
  const pattern = patterns.find((candidate) => candidate.id === patternId) ?? patterns[0];
  const shape = slide?.shapes.find((candidate) => candidate.id === shapeId);
  const readOnly = detail?.builtIn ?? true;
  const working = busy !== null;
  const inChat = detail ? (settings.presentationTemplate ?? defaultTemplate) === detail.id : false;

  function record(outcome: ManifestChangeOutcome) {
    setDetail(outcome.template);
    setLog([
      ...outcome.applied.map((entry) => ({ ok: true, text: entry.message })),
      ...outcome.rejected.map((entry) => ({ ok: false, text: entry.reason })),
      ...(outcome.note ? [{ ok: false, text: outcome.note }] : []),
      ...(outcome.applied.length + outcome.rejected.length === 0 && !outcome.note ? [{ ok: false, text: "Nothing was changed." }] : []),
    ]);
  }

  async function act(label: string, action: () => Promise<void>) {
    if (working) return;
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (reason) {
      if (!abortRef.current?.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
      setProgress(null);
      abortRef.current = null;
    }
  }

  const apply = (changes: ManifestChange[]) => void act("Saving…", async () => record(await changeTemplate(id, changes)));

  function draft() {
    setRedraftArmed(false);
    void act("Drafting layouts…", async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      const drafted = await draftTemplate(id, choice, setProgress, controller.signal);
      setDetail(drafted);
      setShapeId(null);
      setLog([{ ok: true, text: `${drafted.patterns} of ${drafted.slides} slides became layouts${drafted.skipped.length ? `; ${drafted.skipped.length} were left out` : ""}.` }]);
    });
  }

  function instruct(event: FormEvent) {
    event.preventDefault();
    const text = instruction.trim();
    if (!text) return;
    void act("Working out the change…", async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      record(await instructTemplate(id, text, choice, controller.signal));
      setInstruction("");
    });
  }

  if (error && !detail) {
    return (
      <div className="route-page studio-page">
        <Link className="studio-back" to="/templates"><ArrowLeft size={15} /> Templates</Link>
        <div className="panel-error" role="alert"><span>{error}</span></div>
      </div>
    );
  }
  if (!detail || !slide) return <div className="route-page studio-page"><p className="studio-note">Loading the template…</p></div>;

  const errors = detail.issues.filter((issue) => issue.severity === "error");
  const fieldsChanged = detail.fields.some((field) => (fieldDraft[field.name] ?? "") !== field.value);
  // Larger shapes first, so a small shape on top of a large one can still be clicked.
  const drawnShapes = slide.shapes
    .filter((candidate) => candidate.kind !== "group" && candidate.box.w > 0 && candidate.box.h > 0)
    .sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  const unplaced = slide.shapes.filter((candidate) => candidate.kind !== "group" && candidate.kind !== "line" && (candidate.box.w <= 0 || candidate.box.h <= 0));

  return (
    <div className="route-page studio-page studio-editor">
      <Link className="studio-back" to="/templates"><ArrowLeft size={15} /> Templates</Link>
      <header className="studio-editor-head">
        <div>
          <p className="eyebrow">{detail.builtIn ? "SHIPPED WITH THE APP · READ-ONLY" : "TEMPLATE"}</p>
          <h1 dir="auto">{detail.name}</h1>
          <p className="studio-card-meta">
            {detail.slides} slides · {detail.patterns} {detail.patterns === 1 ? "layout" : "layouts"}
            {detail.language ? ` · written in ${detail.language}` : ""} · reads {detail.direction === "rtl" ? "right to left" : "left to right"}
            {detail.draftedWith ? ` · drafted with ${detail.draftedWith}` : ""}
          </p>
        </div>
        <div className="studio-head-actions">
          {inChat ? (
            <span className="studio-in-chat"><Check size={14} /> Used in chat</span>
          ) : (
            <button type="button" className="secondary-button" disabled={detail.patterns === 0} onClick={() => updateSettings({ presentationTemplate: detail.id })}>
              <MessageSquare size={14} /> Use in chat
            </button>
          )}
          <a className={`secondary-button${detail.patterns === 0 ? " studio-disabled" : ""}`} href={templateFileUrl(detail.id, "sample.pptx", "?items=max")} download
            title="Every layout once, every slot filled close to its budget. Text that overflows here will overflow in real decks.">
            <Download size={14} /> Sample deck
          </a>
          <a className="secondary-button" href={templateFileUrl(detail.id, "manifest.json")} download><Download size={14} /> Manifest</a>
          <button type="button" className="secondary-button" disabled={working}
            onClick={() => void act("Copying…", async () => navigate(`/templates/${(await duplicateTemplate(detail.id, `${detail.name} copy`)).id}`))}>
            <Copy size={14} /> Duplicate
          </button>
          {!readOnly ? (
            <button
              type="button"
              className={deleteArmed ? "danger-button" : "icon-button"}
              disabled={working}
              onBlur={() => setDeleteArmed(false)}
              aria-label={deleteArmed ? "Confirm deleting this template" : "Delete this template"}
              title="Delete"
              onClick={() => (deleteArmed
                ? void act("Deleting…", async () => {
                    await deleteTemplate(detail.id);
                    if (settings.presentationTemplate === detail.id) updateSettings({ presentationTemplate: undefined });
                    navigate("/templates");
                  })
                : setDeleteArmed(true))}
            >
              {deleteArmed ? "Delete?" : <Trash2 size={15} />}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <div className="panel-error" role="alert"><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div> : null}
      {readOnly ? <p className="studio-note">This template ships with the app, so it cannot be changed here. Duplicate it to work on a copy.</p> : null}

      {!readOnly ? (
        <section className="studio-ai" aria-label="Model actions">
          {detail.patterns === 0 ? (
            <div className="studio-draft-call">
              <div>
                <h2>Draft the layouts</h2>
                <p>
                  {model} decides, slide by slide, whether it is a reusable layout and what each shape is for. It reads
                  the shapes as measured from the file — no pictures of the slides are sent. {detail.slides + 1} calls.
                </p>
              </div>
              <button type="button" className="primary-button" disabled={working} onClick={draft}>
                {busy === "Drafting layouts…" ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Draft with {model}
              </button>
            </div>
          ) : (
            <form className="studio-instruct" onSubmit={instruct}>
              <label className="studio-field">
                <span>Change it in words</span>
                <textarea
                  className="studio-input"
                  rows={2}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="Make the subtitle optional on every layout. Let the cards take two to five."
                  maxLength={4000}
                  dir="auto"
                  disabled={working}
                />
              </label>
              <div className="studio-instruct-actions">
                <button type="submit" className="primary-button" disabled={working || !instruction.trim()}>
                  {busy === "Working out the change…" ? <LoaderCircle className="spin" size={15} /> : <Wand2 size={15} />} Apply
                </button>
                <button
                  type="button"
                  className={redraftArmed ? "danger-button" : "text-button"}
                  disabled={working}
                  onBlur={() => setRedraftArmed(false)}
                  onClick={() => (redraftArmed ? draft() : setRedraftArmed(true))}
                >
                  {redraftArmed ? "Replace every layout with a new draft?" : "Draft again from the .pptx"}
                </button>
              </div>
            </form>
          )}
          {busy ? (
            <p className="studio-progress" role="status">
              <LoaderCircle className="spin" size={14} /> {busy}
              {progress && progress.total > 0 ? ` slide ${progress.done} of ${progress.total}` : ""}
              {abortRef.current ? <button type="button" className="text-button" onClick={() => abortRef.current?.abort()}>Stop</button> : null}
            </p>
          ) : null}
          {progress && progress.total > 0 ? <progress className="studio-progress-bar" value={progress.done} max={progress.total} /> : null}
        </section>
      ) : null}

      {log.length > 0 ? (
        <ul className="studio-log" aria-label="What changed">
          {log.map((line, index) => (
            <li key={index} className={line.ok ? "studio-log-ok" : "studio-log-no"} dir="auto">
              {line.ok ? <CircleCheck size={14} /> : <X size={14} />}<span>{line.text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="studio-workspace">
        <nav className="studio-slides" aria-label="Slides of the template">
          {detail.view.slides.map((entry) => {
            const first = detail.manifest.patterns.find((candidate) => candidate.sourceSlide === entry.slide);
            return (
              <button
                key={entry.slide}
                type="button"
                className={`studio-slide-button${entry.slide === slide.slide ? " is-selected" : ""}${entry.patterns.length === 0 ? " is-unused" : ""}`}
                onClick={() => {
                  setSlideNumber(entry.slide);
                  setPatternId(null);
                  setShapeId(null);
                }}
              >
                <SlideWireframe aspectRatio={detail.view.aspectRatio} shapes={layoutShapes(entry, first)} label={`Slide ${entry.slide}`} />
                <span><b>{entry.slide}</b> {entry.patterns.length > 0 ? entry.patterns.join(", ") : "not a layout"}</span>
              </button>
            );
          })}
        </nav>

        <div className="studio-stage">
          {patterns.length > 1 ? (
            <div className="studio-tabs" role="tablist" aria-label="Layouts from this slide">
              {patterns.map((candidate) => (
                <button key={candidate.id} type="button" role="tab" aria-selected={candidate.id === pattern?.id}
                  className={candidate.id === pattern?.id ? "is-selected" : undefined} onClick={() => setPatternId(candidate.id)}>
                  {candidate.id}
                </button>
              ))}
            </div>
          ) : null}
          <div className="studio-canvas" style={{ aspectRatio: String(detail.view.aspectRatio) }} aria-label={`Slide ${slide.slide}`}>
            {drawnShapes.map((candidate) => {
              const slot = pattern?.slots.find((entry) => entry.shapeId === candidate.id);
              const box = (slot && slot.kind !== "table" && slot.box) || candidate.box;
              const kind = slot ? (slot.empty === "drop" ? "drop" : slot.kind) : candidate.kind === "line" ? "line" : candidate.frame ? "frame" : "design";
              return (
                <button
                  key={candidate.id}
                  type="button"
                  className={`studio-shape studio-shape-${kind}${candidate.id === shapeId ? " is-selected" : ""}`}
                  style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${Math.max(box.h * 100, 0.6)}%` }}
                  title={slot ? `${slot.name}: ${candidate.slots.find((entry) => entry.pattern === pattern?.id)?.summary ?? slot.kind}` : `#${candidate.id} ${candidate.kind}${candidate.text ? `: ${candidate.text.slice(0, 80)}` : ""}`}
                  onClick={() => setShapeId(candidate.id)}
                >
                  <span dir="auto">{slot ? slot.name : candidate.kind === "text" ? candidate.text : ""}</span>
                </button>
              );
            })}
          </div>
          <div className="studio-legend" aria-hidden="true">
            <span className="studio-key studio-key-text">text</span>
            <span className="studio-key studio-key-image">picture</span>
            <span className="studio-key studio-key-table">table</span>
            <span className="studio-key studio-key-chart">chart</span>
            <span className="studio-key studio-key-drop">always removed</span>
            <span className="studio-key studio-key-design">design, copied as is</span>
          </div>
          {unplaced.length > 0 ? (
            <p className="studio-hint">
              Without a position of their own (they take it from the slide's layout placeholder):{" "}
              {unplaced.map((candidate) => (
                <button key={candidate.id} type="button" className="studio-chip-button" onClick={() => setShapeId(candidate.id)}>
                  #{candidate.id} {candidate.text ? candidate.text.slice(0, 24) : candidate.kind}
                </button>
              ))}
            </p>
          ) : null}
          {pattern ? (
            <div className="studio-slotlist" aria-label="Slots of this layout">
              {pattern.slots.map((slot) => (
                <button key={slot.name} type="button"
                  className={`studio-slot studio-slot-${slot.empty === "drop" ? "drop" : slot.kind}${slot.shapeId === shapeId ? " is-selected" : ""}`}
                  onClick={() => setShapeId(slot.shapeId)}>
                  {slot.name}{slot.empty === "remove" ? "?" : ""}{slot.kind === "text" && slot.deckField ? " · deck" : ""}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <aside className="studio-inspector">
          {pattern ? (
            <>
              {shape ? <ShapeInspector shape={shape} pattern={pattern} readOnly={readOnly} busy={working} apply={apply} /> : (
                <section className="studio-panel"><p className="studio-hint">Click a shape on the slide to see what it is in this layout{readOnly ? "" : " and change it"}.</p></section>
              )}
              <PatternInspector pattern={pattern} readOnly={readOnly} busy={working} apply={apply} />
            </>
          ) : (
            <section className="studio-panel" aria-label="Unused slide">
              <h3>Slide {slide.slide} <small>not a layout</small></h3>
              {detail.skipped.find((entry) => entry.slide === slide.slide)
                ? <p className="studio-hint" dir="auto">Left out by the draft: {detail.skipped.find((entry) => entry.slide === slide.slide)!.reason}</p>
                : <p className="studio-hint">Decks cannot use this slide.</p>}
              {readOnly ? null : (
                <form
                  className="studio-inline"
                  onSubmit={(event) => {
                    event.preventDefault();
                    apply([{ op: "addPattern", slide: slide.slide, id: newPatternId.trim() || `slide-${slide.slide}` }]);
                    setNewPatternId("");
                  }}
                >
                  <label className="studio-field">
                    <span>Make it a layout called</span>
                    <input className="studio-input" value={newPatternId} onChange={(event) => setNewPatternId(event.target.value)} placeholder={`slide-${slide.slide}`} maxLength={48} />
                  </label>
                  <button type="submit" className="secondary-button" disabled={working}>Add</button>
                </form>
              )}
            </section>
          )}
        </aside>
      </div>

      <div className="studio-lower">
        <section className="studio-panel" aria-label="Checks">
          <h3>Checks <small>the manifest against the .pptx</small></h3>
          {detail.issues.length === 0 ? (
            <p className="studio-ok"><CircleCheck size={15} /> {detail.patterns === 0 ? "Nothing to check yet." : "Every layout points at shapes the file has."}</p>
          ) : (
            <ul className="studio-issues">
              {detail.issues.map((issue, index) => (
                <li key={index} className={issue.severity === "error" ? "is-error" : "is-warning"}>
                  <AlertTriangle size={14} />
                  <span><strong>{[issue.pattern, issue.slot].filter(Boolean).join(" / ") || "manifest"}</strong> {issue.message}</span>
                </li>
              ))}
            </ul>
          )}
          {errors.length > 0 ? <p className="studio-hint">Decks made with a layout that has an error can fail to render.</p> : null}
        </section>

        {detail.fields.length > 0 ? (
          <section className="studio-panel" aria-label="Deck fields">
            <h3>Deck fields <small>the same text on every slide of a deck</small></h3>
            <form
              className="studio-stack"
              onSubmit={(event) => {
                event.preventDefault();
                void act("Saving…", async () => setDetail(await saveTemplateFields(id, fieldDraft)));
              }}
            >
              {detail.fields.map((field) => (
                <label className="studio-field" key={field.name}>
                  <span>{field.name}</span>
                  <input
                    className="studio-input"
                    value={fieldDraft[field.name] ?? ""}
                    onChange={(event) => setFieldDraft((current) => ({ ...current, [field.name]: event.target.value }))}
                    placeholder={field.sample || field.name}
                    maxLength={300}
                    dir="auto"
                    disabled={readOnly}
                  />
                </label>
              ))}
              {readOnly
                ? <p className="studio-hint">Decks get the template's own text.</p>
                : <button type="submit" className="secondary-button" disabled={working || !fieldsChanged}>Save</button>}
              {!readOnly ? <p className="studio-hint">Left empty, a deck gets the template's own text.</p> : null}
            </form>
          </section>
        ) : null}

        {!readOnly ? (
          <TemplateSettings detail={detail} busy={working} apply={apply} />
        ) : null}
      </div>
    </div>
  );
}

/** The template's own name, language and reading direction. */
function TemplateSettings({ detail, busy, apply }: {
  detail: PresentationTemplateDetail;
  busy: boolean;
  apply(changes: ManifestChange[]): void;
}) {
  const { manifest } = detail;
  const [name, setName] = useState(manifest.name);
  const [language, setLanguage] = useState(manifest.language ?? "");
  useEffect(() => {
    setName(manifest.name);
    setLanguage(manifest.language ?? "");
  }, [manifest.name, manifest.language]);
  const changed = name.trim() !== manifest.name || language.trim() !== (manifest.language ?? "");
  return (
    <section className="studio-panel" aria-label="Template settings">
      <h3>Template</h3>
      <form
        className="studio-stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed) return;
          apply([{
            op: "setManifest",
            ...(name.trim() !== manifest.name ? { name: name.trim() } : {}),
            ...(language.trim() !== (manifest.language ?? "") ? { language: language.trim() } : {}),
          }]);
        }}
      >
        <label className="studio-field">
          <span>Name</span>
          <input className="studio-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} dir="auto" />
        </label>
        <label className="studio-field">
          <span>Language of the sample text (BCP 47, e.g. en or he)</span>
          <input className="studio-input" value={language} onChange={(event) => setLanguage(event.target.value)} maxLength={20} />
        </label>
        <button type="submit" className="secondary-button" disabled={busy || !changed || !name.trim()}>Save</button>
      </form>
      <label className="studio-field">
        <span>Designed to read</span>
        <select className="studio-input" value={manifest.direction} disabled={busy}
          onChange={(event) => apply([{ op: "setManifest", direction: event.target.value === "rtl" ? "rtl" : "ltr" }])}>
          <option value="ltr">Left to right</option>
          <option value="rtl">Right to left</option>
        </select>
      </label>
      <label className="studio-field">
        <span>In a deck that reads the other way, text alignment</span>
        <select className="studio-input" value={manifest.alignOnDirectionChange ?? "flip"} disabled={busy}
          onChange={(event) => apply([{ op: "setManifest", alignOnDirectionChange: event.target.value === "keep" ? "keep" : "flip" }])}>
          <option value="flip">Mirrors</option>
          <option value="keep">Stays as designed</option>
        </select>
      </label>
    </section>
  );
}
