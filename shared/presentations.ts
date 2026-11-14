// Presentations (slotdeck): what the server and the browser exchange about templates.
// The chat's own events and cards are in contracts.ts.
import type { ManifestChange, ManifestIssue, StudioView, TemplateManifest } from "slotdeck";
import type { ProviderId } from "./contracts.js";

/** Template ids are folder names: lowercase letters, digits and dashes. */
export const PRESENTATION_TEMPLATE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type PresentationTemplateSummary = {
  id: string;
  name: string;
  /** Shipped with the app (presentation-templates/). Read-only: duplicate it to change it. */
  builtIn: boolean;
  /** Slides in the pptx. */
  slides: number;
  /** Layouts decks can use. A template with none cannot make a deck yet. */
  patterns: number;
  language?: string;
  direction: "ltr" | "rtl";
  errors: number;
  warnings: number;
  updatedAt?: string;
  /** Name of the uploaded file. */
  sourceName?: string;
  bytes: number;
};

/** A text that is the same on every slide of a deck, such as the line beside the logo. */
export type PresentationDeckField = {
  name: string;
  /** What decks get. Empty means the template's own sample text. */
  value: string;
  sample: string;
};

export type PresentationTemplateDetail = PresentationTemplateSummary & {
  manifest: TemplateManifest;
  /** Every slide's shapes with their place on the slide and the slots that point at them. */
  view: StudioView;
  issues: ManifestIssue[];
  /** Slides the last draft left out, and why. */
  skipped: Array<{ slide: number; reason: string }>;
  fields: PresentationDeckField[];
  /** The model that drafted the manifest. */
  draftedWith?: string;
};

/** One shape of a layout, for drawing the layout small. Boxes are fractions of the slide. */
export type PatternLayoutShape = {
  box: { x: number; y: number; w: number; h: number };
  fill: "text" | "image" | "table" | "chart" | "design" | "line";
  /** Slot name, for a shape decks fill. */
  label?: string;
  fontSize?: number;
};

export type TemplateLayouts = {
  templateId: string;
  name: string;
  aspectRatio: number;
  patterns: Record<string, { description: string; slide: number; shapes: PatternLayoutShape[] }>;
};

/** Which model a studio action calls: the one picked for the chat. */
export type StudioModelChoice = { provider: ProviderId; model: string };

export type ManifestChangeOutcome = {
  template: PresentationTemplateDetail;
  applied: Array<{ index: number; message: string }>;
  rejected: Array<{ index: number; reason: string }>;
  /** From a change by instruction: what the model could not do, in the person's language. */
  note?: string;
};

export type DraftProgress = { done: number; total: number; slide: number };

export type { ManifestChange, ManifestIssue, StudioView, TemplateManifest };
