// Where presentation templates live: the ones shipped with the app (presentation-templates/)
// and the ones put in PPTX Studio (PRESENTATIONS_DIR/templates). A template is a folder
// with the pptx, the manifest that says which of its shapes are slots, and a few notes.
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PptxPackage,
  checkManifest,
  inspectTemplate,
  studioView,
  type BlobStore,
  type IconDef,
  type ManifestIssue,
  type StudioView,
  type Template,
  type TemplateInfo,
  type TemplateManifest,
} from "slotdeck";
import { directoryStore } from "slotdeck/node";
import {
  PRESENTATION_TEMPLATE_ID,
  type PatternLayoutShape,
  type PresentationDeckField,
  type PresentationTemplateDetail,
  type PresentationTemplateSummary,
  type TemplateLayouts,
} from "../../shared/presentations.js";
import { resolvePresentationSettings } from "./config.js";

/** Notes kept next to a template: everything that is not the pptx or the manifest. */
export type TemplateMeta = {
  name?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Name of the uploaded file. */
  sourceName?: string;
  /** Slides the last draft left out, and why. */
  skipped?: Array<{ slide: number; reason: string }>;
  /** Values for the template's deck fields. A field without one gets the template's sample text. */
  fields?: Record<string, string>;
  draftedWith?: string;
};

export type StoredTemplate = {
  id: string;
  builtIn: boolean;
  directory: string;
  template: Template;
  /** Size of the pptx. */
  bytes: number;
  /** Changes when the pptx file does. */
  stamp: string;
  meta: TemplateMeta;
};

/** A problem to tell the person about, with the HTTP status that fits it. */
export class TemplateError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "TemplateError";
    this.status = status;
  }
}

const PPTX_FILE = "template.pptx";
const MANIFEST_FILE = "manifest.json";
const META_FILE = "meta.json";

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

function slug(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function emptyManifest(name: string): TemplateManifest {
  return { version: 1, name, direction: "ltr", patterns: [] };
}

export class TemplateLibrary {
  readonly directory: string;
  readonly builtInDirectory: string;
  readonly maxTemplateBytes: number;
  private readonly packages = new Map<string, { stamp: string; pkg: PptxPackage; bytes: number }>();
  private readonly inspections = new WeakMap<PptxPackage, TemplateInfo>();
  private readonly iconSets = new Map<string, Promise<IconDef[]>>();

  constructor(options: { directory?: string; builtInDirectory?: string; maxTemplateBytes?: number } = {}) {
    const settings = resolvePresentationSettings();
    this.directory = options.directory ?? settings.directory;
    this.builtInDirectory = options.builtInDirectory ?? settings.builtInDirectory;
    this.maxTemplateBytes = options.maxTemplateBytes ?? settings.maxTemplateBytes;
  }

  private get customDirectory(): string {
    return path.join(this.directory, "templates");
  }

  /** Every template folder, the shipped ones first. */
  private async folders(): Promise<Array<{ id: string; builtIn: boolean; directory: string }>> {
    const found: Array<{ id: string; builtIn: boolean; directory: string }> = [];
    for (const [root, builtIn] of [[this.builtInDirectory, true], [this.customDirectory, false]] as const) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !PRESENTATION_TEMPLATE_ID.test(entry.name)) continue;
        if (found.some((other) => other.id === entry.name)) continue;
        const directory = path.join(root, entry.name);
        if (await exists(path.join(directory, PPTX_FILE))) found.push({ id: entry.name, builtIn, directory });
      }
    }
    return found;
  }

  private async open(folder: { id: string; builtIn: boolean; directory: string }): Promise<StoredTemplate> {
    const file = path.join(folder.directory, PPTX_FILE);
    const info = await stat(file);
    const stamp = `${info.mtimeMs}:${info.size}`;
    let cached = this.packages.get(folder.id);
    if (!cached || cached.stamp !== stamp) {
      // Unzipped once and reused: rendering works on a copy, so the package is never changed.
      cached = { stamp, pkg: PptxPackage.load(new Uint8Array(await readFile(file))), bytes: info.size };
      this.packages.set(folder.id, cached);
    }
    const meta = (await readJson<TemplateMeta>(path.join(folder.directory, META_FILE))) ?? {};
    const manifest = (await readJson<TemplateManifest>(path.join(folder.directory, MANIFEST_FILE))) ?? emptyManifest(meta.name ?? folder.id);
    if (!Array.isArray(manifest.patterns)) manifest.patterns = [];
    return { ...folder, template: { pkg: cached.pkg, manifest }, bytes: cached.bytes, stamp: cached.stamp, meta };
  }

  async list(): Promise<StoredTemplate[]> {
    const templates: StoredTemplate[] = [];
    for (const folder of await this.folders()) {
      // One unreadable file must not hide the other templates.
      try {
        templates.push(await this.open(folder));
      } catch (error) {
        console.warn(`Presentation template "${folder.id}" could not be read:`, error instanceof Error ? error.message : error);
      }
    }
    return templates;
  }

  async get(id: string): Promise<StoredTemplate | undefined> {
    if (!PRESENTATION_TEMPLATE_ID.test(id)) return undefined;
    const folder = (await this.folders()).find((candidate) => candidate.id === id);
    return folder ? this.open(folder) : undefined;
  }

  /** The template with this id; failing that the default one; failing that the first that can make a deck. */
  async resolve(id: string | undefined): Promise<StoredTemplate | undefined> {
    const wanted = id ? await this.get(id) : undefined;
    if (wanted && wanted.template.manifest.patterns.length > 0) return wanted;
    const fallback = await this.get(resolvePresentationSettings().defaultTemplate);
    if (fallback && fallback.template.manifest.patterns.length > 0) return fallback;
    return (await this.list()).find((candidate) => candidate.template.manifest.patterns.length > 0);
  }

  private async editable(id: string): Promise<StoredTemplate> {
    const stored = await this.get(id);
    if (!stored) throw new TemplateError(404, `There is no template "${id}".`);
    if (stored.builtIn) throw new TemplateError(403, `"${displayName(stored)}" ships with the app and cannot be changed. Duplicate it and change the copy.`);
    return stored;
  }

  private async freeId(name: string): Promise<string> {
    const base = slug(name) || "template";
    const taken = new Set((await this.folders()).map((folder) => folder.id));
    let id = PRESENTATION_TEMPLATE_ID.test(base) ? base : "template";
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  /** Keeps an uploaded pptx as a new template with no layouts yet; drafting fills them in. */
  async create(input: { name: string; bytes: Uint8Array; sourceName?: string }): Promise<StoredTemplate> {
    this.checkPptx(input.bytes);

    const name = input.name.replace(/\s+/g, " ").trim().slice(0, 80) || "Template";
    const id = await this.freeId(name);
    const directory = path.join(this.customDirectory, id);
    const now = new Date().toISOString();
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, PPTX_FILE), input.bytes);
    await writeFile(path.join(directory, MANIFEST_FILE), JSON.stringify(emptyManifest(name), null, 2));
    const meta: TemplateMeta = { name, createdAt: now, updatedAt: now, ...(input.sourceName ? { sourceName: input.sourceName } : {}) };
    await writeFile(path.join(directory, META_FILE), JSON.stringify(meta, null, 2));
    return (await this.get(id)) as StoredTemplate;
  }

  /** A copy of a template that can be changed. */
  async duplicate(id: string, name: string): Promise<StoredTemplate> {
    const source = await this.get(id);
    if (!source) throw new TemplateError(404, `There is no template "${id}".`);
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 80) || `${displayName(source)} copy`;
    const copyId = await this.freeId(clean);
    const directory = path.join(this.customDirectory, copyId);
    const now = new Date().toISOString();
    await mkdir(directory, { recursive: true });
    await cp(path.join(source.directory, PPTX_FILE), path.join(directory, PPTX_FILE));
    if (await exists(path.join(source.directory, "icons"))) await cp(path.join(source.directory, "icons"), path.join(directory, "icons"), { recursive: true });
    await writeFile(path.join(directory, MANIFEST_FILE), JSON.stringify({ ...source.template.manifest, name: clean }, null, 2));
    const meta: TemplateMeta = {
      ...source.meta,
      name: clean,
      createdAt: now,
      updatedAt: now,
      sourceName: source.meta.sourceName ?? `${displayName(source)} (${source.builtIn ? "shipped with the app" : "copy"})`,
    };
    await writeFile(path.join(directory, META_FILE), JSON.stringify(meta, null, 2));
    return (await this.get(copyId)) as StoredTemplate;
  }

  async saveManifest(id: string, manifest: TemplateManifest, patch: Partial<TemplateMeta> = {}): Promise<StoredTemplate> {
    const stored = await this.editable(id);
    await writeFile(path.join(stored.directory, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
    // The manifest's name is the template's name: one is not left behind when the other changes.
    const meta: TemplateMeta = { ...stored.meta, ...patch, name: manifest.name || stored.meta.name, updatedAt: new Date().toISOString() };
    await writeFile(path.join(stored.directory, META_FILE), JSON.stringify(meta, null, 2));
    return (await this.get(id)) as StoredTemplate;
  }

  /**
   * Keeps a manifest that was written or changed outside the studio's own controls: pasted,
   * edited as JSON, or imported from a file. It has to be a manifest the library can work with;
   * whether it matches the pptx is for the checks to say, so a half-finished one can be saved.
   */
  async importManifest(id: string, input: unknown): Promise<StoredTemplate> {
    const stored = await this.editable(id);
    const manifest = parseManifest(input);
    try {
      // Everything the studio and the chat do with a manifest, tried once before it is kept.
      const candidate = { ...stored, template: { ...stored.template, manifest } };
      checkManifest(candidate.template, this.inspect(stored));
      studioView(candidate.template);
      deckFields(candidate);
    } catch (error) {
      throw new TemplateError(422, `This manifest cannot be used: ${error instanceof Error ? error.message : String(error)}`);
    }
    // A manifest from elsewhere says nothing about slides a draft here once left out.
    return this.saveManifest(id, manifest, { skipped: [] });
  }

  /**
   * Puts another pptx in a template's place and keeps its manifest: for a deck that was edited
   * in PowerPoint. Shape ids can change there, and the checks then say which slots lost theirs.
   */
  async replacePptx(id: string, bytes: Uint8Array, sourceName?: string): Promise<StoredTemplate> {
    const stored = await this.editable(id);
    this.checkPptx(bytes);
    await writeFile(path.join(stored.directory, PPTX_FILE), bytes);
    this.packages.delete(id);
    return this.saveMeta(id, sourceName ? { sourceName } : {});
  }

  /** Refuses bytes that are not a presentation with slides. */
  private checkPptx(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) throw new TemplateError(400, "The upload is empty.");
    if (bytes.byteLength > this.maxTemplateBytes) {
      throw new TemplateError(413, `The file is larger than the ${Math.round(this.maxTemplateBytes / 1024 / 1024)} MB template limit.`);
    }
    let slides: number;
    try {
      slides = inspectTemplate(PptxPackage.load(bytes)).slides.length;
    } catch {
      throw new TemplateError(422, "This file is not a PowerPoint presentation (.pptx).");
    }
    if (slides === 0) throw new TemplateError(422, "This presentation has no slides.");
  }

  async saveMeta(id: string, patch: Partial<TemplateMeta>): Promise<StoredTemplate> {
    const stored = await this.editable(id);
    const meta: TemplateMeta = { ...stored.meta, ...patch, updatedAt: new Date().toISOString() };
    await writeFile(path.join(stored.directory, META_FILE), JSON.stringify(meta, null, 2));
    return (await this.get(id)) as StoredTemplate;
  }

  async remove(id: string): Promise<void> {
    const stored = await this.editable(id);
    this.packages.delete(id);
    await rm(stored.directory, { recursive: true, force: true });
  }

  async pptx(stored: StoredTemplate): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path.join(stored.directory, PPTX_FILE)));
  }

  inspect(stored: StoredTemplate): TemplateInfo {
    let info = this.inspections.get(stored.template.pkg);
    if (!info) {
      info = inspectTemplate(stored.template.pkg);
      this.inspections.set(stored.template.pkg, info);
    }
    return info;
  }

  /**
   * The icons decks may pick from: the template's own (an icons/ folder with icons.json beside
   * the pptx) or the set shipped with the app. Layouts with icon slots need one to be offered.
   */
  icons(stored: StoredTemplate): Promise<IconDef[]> {
    const own = path.join(stored.directory, "icons");
    const shared = path.join(this.builtInDirectory, "icons");
    const load = (directory: string): Promise<IconDef[]> => {
      let set = this.iconSets.get(directory);
      if (!set) {
        set = (async () => {
          const index = await readJson<Array<{ id?: unknown; description?: unknown }>>(path.join(directory, "icons.json"));
          const icons: IconDef[] = [];
          for (const entry of Array.isArray(index) ? index : []) {
            if (typeof entry?.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) continue;
            const data = await readFile(path.join(directory, `${entry.id}.png`)).catch(() => undefined);
            if (data) icons.push({ id: entry.id, description: typeof entry.description === "string" ? entry.description : entry.id, data: new Uint8Array(data) });
          }
          return icons;
        })();
        this.iconSets.set(directory, set);
      }
      return set;
    };
    return load(own).then((icons) => (icons.length > 0 ? icons : load(shared)));
  }

  /** Where the chat tools keep the plans, decks, pictures and files made with a template. */
  store(templateId: string): BlobStore {
    if (!PRESENTATION_TEMPLATE_ID.test(templateId)) throw new TemplateError(400, "Invalid template id.");
    return directoryStore(path.join(this.directory, "decks", templateId));
  }

  issues(stored: StoredTemplate): ManifestIssue[] {
    return checkManifest(stored.template, this.inspect(stored));
  }

  summary(stored: StoredTemplate): PresentationTemplateSummary {
    const { manifest } = stored.template;
    const issues = this.issues(stored);
    return {
      id: stored.id,
      name: displayName(stored),
      builtIn: stored.builtIn,
      slides: this.inspect(stored).slides.length,
      patterns: manifest.patterns.length,
      ...(manifest.language ? { language: manifest.language } : {}),
      direction: manifest.direction === "rtl" ? "rtl" : "ltr",
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
      ...(stored.meta.updatedAt ? { updatedAt: stored.meta.updatedAt } : {}),
      ...(stored.meta.sourceName ? { sourceName: stored.meta.sourceName } : {}),
      bytes: stored.bytes,
    };
  }

  detail(stored: StoredTemplate): PresentationTemplateDetail {
    const view = studioView(stored.template);
    return {
      ...this.summary(stored),
      manifest: stored.template.manifest,
      view,
      issues: this.issues(stored),
      skipped: stored.meta.skipped ?? [],
      fields: deckFields(stored, view),
      ...(stored.meta.draftedWith ? { draftedWith: stored.meta.draftedWith } : {}),
    };
  }

  /** Every layout as a few boxes, for drawing a plan's slides small. */
  layouts(stored: StoredTemplate): TemplateLayouts {
    const view = studioView(stored.template);
    const patterns: TemplateLayouts["patterns"] = {};
    for (const pattern of stored.template.manifest.patterns) {
      const slide = view.slides[pattern.sourceSlide - 1];
      const shapes: PatternLayoutShape[] = [];
      for (const shape of slide?.shapes ?? []) {
        if (shape.kind === "group") continue;
        const slot = pattern.slots.find((candidate) => candidate.shapeId === shape.id);
        // A shape the layout always removes is not part of what a deck gets.
        if (slot?.empty === "drop") continue;
        const box = (slot && slot.kind !== "table" && slot.box) || shape.box;
        if (shape.kind !== "line" && (box.w <= 0 || box.h <= 0)) continue;
        const entry: PatternLayoutShape = {
          box: { x: box.x, y: box.y, w: box.w, h: box.h },
          fill: slot ? slot.kind : shape.kind === "line" ? "line" : "design",
        };
        if (slot) entry.label = slot.name;
        const size = slot?.kind === "text" ? (slot.fontSize ?? slot.size ?? shape.fontSize) : undefined;
        if (size !== undefined) entry.fontSize = size;
        shapes.push(entry);
      }
      patterns[pattern.id] = { description: pattern.description, slide: pattern.sourceSlide, shapes };
    }
    return { templateId: stored.id, name: displayName(stored), aspectRatio: view.aspectRatio, patterns };
  }
}

const SLOT_KINDS = new Set(["text", "image", "table", "chart"]);

/**
 * Reads a manifest that came in as JSON. It checks the shape every use of a manifest relies on,
 * and names the first thing that is wrong in words a person editing the JSON can act on.
 */
export function parseManifest(input: unknown): TemplateManifest {
  const fail = (message: string): never => {
    throw new TemplateError(422, message);
  };
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (!record(input)) return fail("A manifest is a JSON object.");
  if (input.version !== 1) fail('A manifest has "version": 1.');
  if (typeof input.name !== "string" || !input.name.trim()) fail('A manifest has a "name".');
  if (input.direction !== "ltr" && input.direction !== "rtl") fail('"direction" is "ltr" or "rtl".');
  if (!Array.isArray(input.patterns)) return fail('"patterns" is a list.');
  const ids = new Set<string>();
  input.patterns.forEach((pattern: unknown, index: number) => {
    const where = `patterns[${index}]`;
    if (!record(pattern)) return fail(`${where} is not an object.`);
    if (typeof pattern.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(pattern.id)) fail(`${where}.id is made of lowercase letters, digits and dashes.`);
    const id = pattern.id as string;
    if (ids.has(id)) fail(`Two patterns are called "${id}".`);
    ids.add(id);
    if (!Number.isInteger(pattern.sourceSlide) || (pattern.sourceSlide as number) < 1) fail(`"${id}": sourceSlide is a slide number, from 1.`);
    if (typeof pattern.description !== "string") fail(`"${id}" has no description.`);
    if (!Array.isArray(pattern.slots)) return fail(`"${id}": slots is a list.`);
    pattern.slots.forEach((slot: unknown, position: number) => {
      if (!record(slot)) return fail(`"${id}": slots[${position}] is not an object.`);
      if (typeof slot.name !== "string" || !slot.name) fail(`"${id}": slots[${position}] has no name.`);
      if (typeof slot.kind !== "string" || !SLOT_KINDS.has(slot.kind)) fail(`"${id}": the kind of "${String(slot.name)}" is text, image, table or chart.`);
      if (typeof slot.shapeId !== "string" || !slot.shapeId) fail(`"${id}": the shapeId of "${String(slot.name)}" is the shape's id as text, such as "5".`);
    });
    if (pattern.repeat !== undefined) {
      const repeat = pattern.repeat;
      if (!record(repeat) || !Array.isArray(repeat.slots) || !Array.isArray(repeat.shapes)
        || repeat.slots.some((name: unknown) => typeof name !== "string")
        || repeat.shapes.some((item: unknown) => !Array.isArray(item) || item.some((shape: unknown) => typeof shape !== "string"))) {
        fail(`"${id}": repeat needs "slots" (names with {n}) and "shapes" (a list of shape ids for each item).`);
      }
    }
  });
  return input as unknown as TemplateManifest;
}

export function displayName(stored: StoredTemplate): string {
  return stored.meta.name?.trim() || stored.template.manifest.name?.trim() || stored.id;
}

/** The template's deck fields, each with the value decks get and the template's own sample text. */
export function deckFields(stored: StoredTemplate, view: StudioView = studioView(stored.template)): PresentationDeckField[] {
  const fields = new Map<string, PresentationDeckField>();
  for (const pattern of stored.template.manifest.patterns) {
    for (const slot of pattern.slots) {
      if (slot.kind !== "text" || !slot.deckField || fields.has(slot.deckField)) continue;
      const shape = view.slides[pattern.sourceSlide - 1]?.shapes.find((candidate) => candidate.id === slot.shapeId);
      fields.set(slot.deckField, { name: slot.deckField, value: stored.meta.fields?.[slot.deckField]?.trim() ?? "", sample: shape?.text ?? "" });
    }
  }
  return [...fields.values()];
}

/**
 * Values for every deck field, so no layout is withheld for lack of one: what PPTX Studio
 * was given, or else the text the template itself shows there.
 */
export function deckFieldValues(stored: StoredTemplate): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of deckFields(stored)) values[field.name] = field.value || field.sample || field.name;
  return values;
}
