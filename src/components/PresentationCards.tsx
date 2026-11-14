import { AlertTriangle, Download, LayoutTemplate, Play, Presentation } from "lucide-react";
import { useEffect, useState } from "react";
import type { ChatPresentationCard } from "../../shared/contracts";
import type { TemplateLayouts } from "../../shared/presentations";
import { fetchTemplateLayouts } from "../lib/presentations";
import { SlideWireframe } from "./SlideWireframe";

function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The boxes of a template's layouts, or nothing while they load or when the template is gone. */
function useLayouts(templateId: string): TemplateLayouts | null {
  const [layouts, setLayouts] = useState<TemplateLayouts | null>(null);
  useEffect(() => {
    let current = true;
    fetchTemplateLayouts(templateId).then(
      (loaded) => { if (current) setLayouts(loaded); },
      () => { if (current) setLayouts(null); },
    );
    return () => { current = false; };
  }, [templateId]);
  return layouts;
}

function SlideThumb({ layouts, layout }: { layouts: TemplateLayouts | null; layout: string }) {
  const pattern = layouts?.patterns[layout];
  if (!layouts || !pattern) return <span className="deck-thumb deck-thumb-empty" aria-hidden="true" />;
  return <SlideWireframe className="deck-thumb" aspectRatio={layouts.aspectRatio} shapes={pattern.shapes} label={`Layout ${layout}`} />;
}

function PlanCard({ card, onApprove }: {
  card: Extract<ChatPresentationCard, { kind: "plan" }>;
  /** Set on the plan that is waiting for an answer. */
  onApprove?: () => void;
}) {
  const layouts = useLayouts(card.templateId);
  return (
    <section className="deck-card deck-card-plan" aria-label={`Presentation plan: ${card.title}`}>
      <header className="deck-card-head">
        <span className="deck-card-icon"><LayoutTemplate size={17} /></span>
        <div>
          <p className="deck-card-kind">Plan · not created yet</p>
          <h3 dir="auto">{card.title}</h3>
          <p className="deck-card-meta">{card.slides.length} slides · template {card.templateName}{card.language ? ` · ${card.language}` : ""}</p>
        </div>
      </header>
      {card.summary ? <p className="deck-card-summary" dir="auto">{card.summary}</p> : null}
      <ol className="deck-plan-slides">
        {card.slides.map((slide) => (
          <li key={slide.number}>
            <SlideThumb layouts={layouts} layout={slide.layout} />
            <div>
              <strong><span className="deck-slide-number">{slide.number}</span>{slide.layout}</strong>
              <p dir="auto">{slide.purpose}</p>
            </div>
          </li>
        ))}
      </ol>
      {onApprove ? (
        <footer className="deck-card-actions">
          <button type="button" className="primary-button" onClick={onApprove}><Play size={15} /> Create presentation</button>
          <span>or say what to change</span>
        </footer>
      ) : null}
    </section>
  );
}

function DeckCard({ card }: { card: Extract<ChatPresentationCard, { kind: "deck" }> }) {
  const layouts = useLayouts(card.templateId);
  return (
    <section className="deck-card deck-card-file" aria-label={`Presentation: ${card.title}`}>
      <header className="deck-card-head">
        <span className="deck-card-icon"><Presentation size={17} /></span>
        <div>
          <p className="deck-card-kind">PowerPoint presentation</p>
          <h3 dir="auto">{card.title}</h3>
          <p className="deck-card-meta">{card.slides.length} slides · {fileSize(card.bytes)} · template {card.templateName}</p>
        </div>
        <a className="primary-button deck-download" href={card.file} download>
          <Download size={15} /> Download
        </a>
      </header>
      {card.summary ? <p className="deck-card-summary" dir="auto">{card.summary}</p> : null}
      <ol className="deck-strip" aria-label="Slides">
        {card.slides.map((slide) => (
          <li key={slide.number} title={slide.title ? `${slide.number}. ${slide.title}` : `${slide.number}. ${slide.layout}`}>
            <SlideThumb layouts={layouts} layout={slide.layout} />
            <span dir="auto"><b>{slide.number}</b> {slide.title ?? slide.layout}</span>
          </li>
        ))}
      </ol>
      {card.warnings?.length ? (
        <details className="deck-warnings">
          <summary><AlertTriangle size={14} /> {card.warnings.length} {card.warnings.length === 1 ? "thing" : "things"} to check in the file</summary>
          <ul>{card.warnings.map((warning, index) => <li key={index} dir="auto">{warning}</li>)}</ul>
        </details>
      ) : null}
    </section>
  );
}

/** The plans and decks the presentation tools made in one answer. */
export function PresentationCards({ cards, pendingPlanId, onApprove }: {
  cards: ChatPresentationCard[];
  /** The plan the conversation is waiting on, if it is one of these. */
  pendingPlanId?: string;
  onApprove(): void;
}) {
  return (
    <div className="deck-cards">
      {cards.map((card) => card.kind === "plan"
        ? <PlanCard key={card.id} card={card} {...(card.id === pendingPlanId ? { onApprove } : {})} />
        : <DeckCard key={card.id} card={card} />)}
    </div>
  );
}
