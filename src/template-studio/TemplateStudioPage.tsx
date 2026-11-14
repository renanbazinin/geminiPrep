import { AlertTriangle, ArrowUpRight, Check, FileUp, LoaderCircle, MessageSquare, Presentation, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { PresentationTemplateSummary, TemplateLayouts } from "../../shared/presentations";
import { chatModelFor } from "../../shared/gemini-4";
import { SlideWireframe } from "../components/SlideWireframe";
import { useApp } from "../contexts/AppContext";
import { deleteTemplate, fetchTemplateLayouts, fetchTemplates, uploadTemplate, type TemplateList } from "../lib/presentations";
import { TemplateEditor } from "./TemplateEditor";
import "./template-studio.css";

function megabytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The first layouts of a template, drawn small. */
function TemplatePreview({ id, patterns }: { id: string; patterns: number }) {
  const [layouts, setLayouts] = useState<TemplateLayouts | null>(null);
  useEffect(() => {
    let current = true;
    if (patterns > 0) fetchTemplateLayouts(id).then((loaded) => { if (current) setLayouts(loaded); }, () => undefined);
    return () => { current = false; };
  }, [id, patterns]);
  const shown = layouts ? Object.entries(layouts.patterns).slice(0, 3) : [];
  if (shown.length === 0) return <div className="studio-preview studio-preview-empty">{patterns === 0 ? "No layouts yet" : ""}</div>;
  return (
    <div className="studio-preview">
      {shown.map(([pattern, layout]) => (
        <SlideWireframe key={pattern} aspectRatio={layouts!.aspectRatio} shapes={layout.shapes} label={`Layout ${pattern}`} />
      ))}
    </div>
  );
}

function TemplateCard({ template, inChat, onUse, onDelete }: {
  template: PresentationTemplateSummary;
  inChat: boolean;
  onUse(): void;
  onDelete(): void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <article className={`studio-card${inChat ? " studio-card-active" : ""}`}>
      <Link className="studio-card-open" to={`/templates/${template.id}`} aria-label={`Open ${template.name}`}>
        <TemplatePreview id={template.id} patterns={template.patterns} />
        <div className="studio-card-title">
          <h2 dir="auto">{template.name}</h2>
          <ArrowUpRight size={16} />
        </div>
        <p className="studio-card-meta">
          {template.slides} slides · {template.patterns} {template.patterns === 1 ? "layout" : "layouts"} · {megabytes(template.bytes)}
          {template.language ? ` · ${template.language}` : ""}{template.direction === "rtl" ? " · right to left" : ""}
        </p>
      </Link>
      <div className="studio-card-foot">
        <div className="studio-badges">
          {template.builtIn ? <span className="studio-badge">Shipped with the app</span> : null}
          {template.errors > 0 ? <span className="studio-badge studio-badge-bad"><AlertTriangle size={12} /> {template.errors} to fix</span> : null}
          {template.errors === 0 && template.warnings > 0 ? <span className="studio-badge studio-badge-warn">{template.warnings} to check</span> : null}
        </div>
        <div className="studio-card-actions">
          {inChat ? (
            <span className="studio-in-chat"><Check size={14} /> Used in chat</span>
          ) : (
            <button type="button" className="secondary-button" onClick={onUse} disabled={template.patterns === 0}
              title={template.patterns === 0 ? "Draft its layouts first" : "The chat's presentation tools will use this template"}>
              <MessageSquare size={14} /> Use in chat
            </button>
          )}
          {!template.builtIn ? (
            <button
              type="button"
              className={armed ? "danger-button" : "icon-button"}
              onClick={() => (armed ? onDelete() : setArmed(true))}
              onBlur={() => setArmed(false)}
              aria-label={armed ? `Confirm deleting ${template.name}` : `Delete ${template.name}`}
              title="Delete"
            >
              {armed ? "Delete?" : <Trash2 size={15} />}
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function TemplateListView() {
  const { settings, updateSettings } = useApp();
  const navigate = useNavigate();
  const [list, setList] = useState<TemplateList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(() => {
    fetchTemplates().then(setList, (reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);
  useEffect(reload, [reload]);

  const inChat = list
    ? (list.templates.some((template) => template.id === settings.presentationTemplate && template.patterns > 0)
      ? settings.presentationTemplate
      : list.templates.some((template) => template.id === list.defaultTemplate) ? list.defaultTemplate : list.templates.find((template) => template.patterns > 0)?.id)
    : undefined;

  async function upload() {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      const created = await uploadTemplate(file, name.trim() || file.name.replace(/\.pptx$/i, ""));
      // The editor offers the draft as its first step.
      navigate(`/templates/${created.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await deleteTemplate(id);
      if (settings.presentationTemplate === id) updateSettings({ presentationTemplate: undefined });
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="route-page studio-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">SLOTDECK TEMPLATES</p>
          <h1>Template Studio</h1>
          <p>
            Turn a PowerPoint deck into a template for the chat's presentation tools. Each sample slide becomes a
            layout, and the shapes you mark as slots are what a new deck fills. Everything else — logo, backgrounds,
            fonts — is copied as designed.
          </p>
        </div>
      </header>
      {error ? <div className="panel-error" role="alert"><span>{error}</span><button onClick={() => setError(null)}>Dismiss</button></div> : null}

      <section className="studio-upload" aria-label="New template">
        <div className="studio-upload-copy">
          <span className="studio-upload-icon"><FileUp size={20} /></span>
          <div>
            <h2>New template from a .pptx</h2>
            <p>
              Upload a deck of sample slides. {chatModelFor(settings)} then drafts its layouts, one call per slide. It
              gets the measured shapes of each slide — positions, sizes, fonts, sample text — and no pictures of the slides.
            </p>
          </div>
        </div>
        <div className="studio-upload-form">
          <input
            ref={fileRef}
            className="file-input"
            type="file"
            accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
            aria-label="PowerPoint file"
            onChange={(event) => {
              const picked = event.target.files?.[0] ?? null;
              setFile(picked);
              if (picked && !name.trim()) setName(picked.name.replace(/\.pptx$/i, ""));
            }}
          />
          <button type="button" className="secondary-button" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Presentation size={15} /> {file ? file.name : "Choose a .pptx"}
          </button>
          <input
            className="studio-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Template name"
            aria-label="Template name"
            maxLength={80}
            disabled={uploading}
          />
          <button type="button" className="primary-button" onClick={() => void upload()} disabled={!file || uploading}>
            {uploading ? <LoaderCircle className="spin" size={15} /> : <FileUp size={15} />} Upload
          </button>
        </div>
      </section>

      <div className="tests-section-label">Templates</div>
      {!list ? <p className="studio-note">Loading templates…</p> : null}
      {list && list.templates.length === 0 ? <p className="studio-note">No templates yet. Upload a .pptx to make the first one.</p> : null}
      <div className="studio-grid">
        {list?.templates.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            inChat={template.id === inChat}
            onUse={() => updateSettings({ presentationTemplate: template.id })}
            onDelete={() => void remove(template.id)}
          />
        ))}
      </div>
      {list ? (
        <p className="studio-note">
          Templates made here are kept on this server's disk. {list.photos
            ? "Decks get generated photos, one image-model call each."
            : "Photos are turned off on this server, so decks are planned without them."}
        </p>
      ) : null}
    </div>
  );
}

export function TemplateStudioPage() {
  const { id } = useParams();
  return id ? <TemplateEditor key={id} id={id} /> : <TemplateListView />;
}
