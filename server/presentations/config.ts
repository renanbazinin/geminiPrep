import path from "node:path";

const MB = 1024 * 1024;

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** A yes/no setting. Unset keeps the fallback; "0", "false", "off" and "no" turn it off. */
function enabled(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}

const IMAGE_SIZES = ["512", "1K", "2K", "4K"] as const;
export type PresentationImageSize = (typeof IMAGE_SIZES)[number];
const THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type PresentationThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Settings of the presentation tools and Template Studio, from the environment. */
export function resolvePresentationSettings() {
  const size = process.env.PRESENTATIONS_IMAGE_SIZE?.trim();
  const thinking = process.env.PRESENTATIONS_THINKING_LEVEL?.trim().toLowerCase();
  return {
    /** Templates made in Template Studio, and the plans, decks, pictures and files of the chat tools. */
    directory: process.env.PRESENTATIONS_DIR?.trim() || path.resolve(process.cwd(), ".data", "presentations"),
    /** Templates shipped with the app, and the icon set decks pick from. */
    builtInDirectory: path.resolve(process.cwd(), "presentation-templates"),
    /** The template the chat uses when the browser names none. */
    defaultTemplate: process.env.PRESENTATIONS_DEFAULT_TEMPLATE?.trim() || "demo",
    /**
     * Photos are generated with the image model, one paid call each. Off, decks are planned
     * with no photos (layouts that need one are not offered).
     */
    photos: enabled("PRESENTATIONS_PHOTOS", true),
    imageSize: (IMAGE_SIZES as readonly string[]).includes(size ?? "") ? size as PresentationImageSize : "1K",
    /** Appended to every photo description. */
    imageStyle: process.env.PRESENTATIONS_IMAGE_STYLE?.trim() || "Natural-light editorial photograph. No text, captions or logos.",
    /**
     * The model that plans and writes decks and drafts manifests. Unset, it is the model picked
     * in the chat. It is called with the chat's provider and credentials.
     */
    model: process.env.PRESENTATIONS_MODEL?.trim() || undefined,
    /**
     * How hard that model thinks, on every call. Unset, slotdeck asks for "low" on its planning
     * calls (the outline, a change to a plan, the first step of an edit), which keeps a plan to a
     * few seconds, and leaves the model's own default for the rest. Gemini 4 refuses "minimal".
     */
    thinkingLevel: (THINKING_LEVELS as readonly string[]).includes(thinking ?? "") ? thinking as PresentationThinkingLevel : undefined,
    /** The most rounds of tool calls in one chat answer. */
    maxToolTurns: Math.max(2, Math.round(positive("PRESENTATIONS_MAX_TOOL_TURNS", 6))),
    maxTemplateBytes: Math.round(positive("PRESENTATIONS_MAX_TEMPLATE_MB", 60) * MB),
  };
}

export type PresentationSettings = ReturnType<typeof resolvePresentationSettings>;
