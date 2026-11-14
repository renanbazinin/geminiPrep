// Template Studio's API, and the download of decks the chat tools made.
//
// Mount before `express.json()`: a template arrives as the raw bytes of the pptx.
import express, { type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import {
  changeManifest,
  draftManifest,
  editManifest,
  renderDeck,
  sampleDeck,
  storeKeys,
  type DeckSpec,
  type ManifestChange,
} from "slotdeck";
import type { ProviderId } from "../../shared/contracts.js";
import type { DraftProgress, ManifestChangeOutcome, StudioModelChoice } from "../../shared/presentations.js";
import { resolveGeminiChatModels, resolveVertexChatModels, resolveVertexProject } from "../catalog.js";
import { resolvePresentationSettings } from "./config.js";
import { presentationModels } from "./models.js";
import { TemplateError, displayName, type StoredTemplate, type TemplateLibrary } from "./templates.js";

const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const MAX_CHANGES = 60;

function headerText(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A file name a browser saves under, from a title in any language. */
export function downloadName(title: string, extension: string): string {
  const clean = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${clean || "presentation"}.${extension}`;
}

/** A path parameter as one string. */
function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}

function attach(res: Response, filename: string): void {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
}

/** The model a studio action calls: one the chat could have picked, with the server's credentials. */
export function modelChoice(body: unknown): StudioModelChoice {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (input.provider !== "vertex" && input.provider !== "gemini") throw new TemplateError(400, "provider must be either vertex or gemini.");
  const provider: ProviderId = input.provider;
  const models = provider === "vertex" ? resolveVertexChatModels() : resolveGeminiChatModels();
  if (typeof input.model !== "string" || !models.some((candidate) => candidate.id === input.model)) {
    throw new TemplateError(400, `Model ${String(input.model)} is not configured for ${provider}.`);
  }
  return { provider, model: input.model };
}

export function presentationRoutes(options: { library: TemplateLibrary; fetchImpl?: typeof fetch }) {
  const { library } = options;
  const router = express.Router();
  const json = express.json({ limit: "2mb" });
  const run = (handler: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
  const found = async (id: string | undefined): Promise<StoredTemplate> => {
    const stored = id ? await library.get(id) : undefined;
    if (!stored) throw new TemplateError(404, "This template is not on the server.");
    return stored;
  };
  const changeable = (stored: StoredTemplate): StoredTemplate => {
    if (stored.builtIn) throw new TemplateError(403, `"${displayName(stored)}" ships with the app and cannot be changed. Duplicate it and change the copy.`);
    return stored;
  };
  const models = (choice: StudioModelChoice) => presentationModels({
    ...choice,
    project: resolveVertexProject(null).project,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  router.get("/templates", run(async (_req, res) => {
    const settings = resolvePresentationSettings();
    const templates = (await library.list()).map((stored) => library.summary(stored));
    res.json({ templates, defaultTemplate: settings.defaultTemplate, photos: settings.photos });
  }));

  router.post("/templates", express.raw({ type: () => true, limit: library.maxTemplateBytes }), run(async (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const sourceName = headerText(req.headers["x-file-name"]).trim();
    const name = headerText(req.headers["x-template-name"]).trim() || sourceName.replace(/\.pptx$/i, "");
    const stored = await library.create({
      name,
      bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      ...(sourceName ? { sourceName } : {}),
    });
    res.status(201).json(library.detail(stored));
  }));

  router.get("/templates/:id", run(async (req, res) => {
    res.json(library.detail(await found(param(req, "id"))));
  }));

  router.delete("/templates/:id", run(async (req, res) => {
    await found(param(req, "id"));
    await library.remove(param(req, "id"));
    res.json({ deleted: true });
  }));

  router.post("/templates/:id/duplicate", json, run(async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    res.status(201).json(library.detail(await library.duplicate(param(req, "id"), name)));
  }));

  /**
   * Drafts the manifest with a model: one call about the deck, then one per slide. The model
   * gets the measured shapes of each slide and no picture of it. Progress and the result are
   * sent as server-sent events, because a large template takes a minute or two.
   */
  router.post("/templates/:id/draft", json, run(async (req, res) => {
    const stored = changeable(await found(param(req, "id")));
    const choice = modelChoice(req.body);
    const { llm, model } = models(choice);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" });
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (!abort.signal.aborted && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const total = library.inspect(stored).slides.length;
      send("progress", { done: 0, total, slide: 0 } satisfies DraftProgress);
      const draft = await draftManifest(stored.template.pkg, {
        llm,
        name: displayName(stored),
        onProgress: (event) => send("progress", event satisfies DraftProgress),
        signal: abort.signal,
      });
      const saved = await library.saveManifest(stored.id, draft.manifest, { skipped: draft.skipped, draftedWith: model });
      send("result", library.detail(saved));
    } catch (error) {
      if (!abort.signal.aborted) send("error", { message: error instanceof Error ? error.message : String(error) });
    }
    res.end();
  }));

  /** Changes made by hand in the studio. Each is checked against the pptx; what cannot work is refused. */
  router.post("/templates/:id/changes", json, run(async (req, res) => {
    const stored = changeable(await found(param(req, "id")));
    const changes: unknown = req.body?.changes;
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES
      || changes.some((change) => !change || typeof change !== "object" || typeof (change as { op?: unknown }).op !== "string")) {
      throw new TemplateError(400, `changes must be a list of 1 to ${MAX_CHANGES} operations.`);
    }
    const result = changeManifest(stored.template, changes as ManifestChange[]);
    const saved = result.applied.length > 0 ? await library.saveManifest(stored.id, result.manifest) : stored;
    res.json({
      template: library.detail(saved),
      applied: result.applied.map(({ index, message }) => ({ index, message })),
      rejected: result.rejected.map(({ index, reason }) => ({ index, reason })),
    } satisfies ManifestChangeOutcome);
  }));

  /** A change asked for in words. The model answers with the same operations, so the same checks apply. */
  router.post("/templates/:id/instruct", json, run(async (req, res) => {
    const stored = changeable(await found(param(req, "id")));
    const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
    if (!instruction) throw new TemplateError(400, "Say what to change.");
    if (instruction.length > 4_000) throw new TemplateError(400, "The instruction cannot exceed 4,000 characters.");
    if (stored.template.manifest.patterns.length === 0) throw new TemplateError(409, "This template has no layouts yet. Draft it first.");
    const { llm } = models(modelChoice(req.body));
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const result = await editManifest(stored.template, instruction, { llm, signal: abort.signal });
    const saved = result.applied.length > 0 ? await library.saveManifest(stored.id, result.manifest) : stored;
    res.json({
      template: library.detail(saved),
      applied: result.applied.map(({ index, message }) => ({ index, message })),
      rejected: result.rejected.map(({ index, reason }) => ({ index, reason })),
      ...(result.note ? { note: result.note } : {}),
    } satisfies ManifestChangeOutcome);
  }));

  /** Values for the texts that are the same on every slide of a deck. */
  router.put("/templates/:id/fields", json, run(async (req, res) => {
    const stored = changeable(await found(param(req, "id")));
    const input: unknown = req.body?.fields;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TemplateError(400, "fields must be an object.");
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(input)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) || typeof value !== "string" || value.length > 300) throw new TemplateError(400, `The value of "${name}" is not valid.`);
      if (value.trim()) fields[name] = value.trim();
    }
    res.json(library.detail(await library.saveMeta(stored.id, { fields })));
  }));

  router.get("/templates/:id/layouts", run(async (req, res) => {
    res.json(library.layouts(await found(param(req, "id"))));
  }));

  router.get("/templates/:id/manifest.json", run(async (req, res) => {
    const stored = await found(param(req, "id"));
    attach(res, `${stored.id}.manifest.json`);
    res.type("application/json").send(JSON.stringify(stored.template.manifest, null, 2));
  }));

  router.get("/templates/:id/template.pptx", run(async (req, res) => {
    const stored = await found(param(req, "id"));
    attach(res, `${stored.id}.pptx`);
    res.type(PPTX_TYPE).send(Buffer.from(await library.pptx(stored)));
  }));

  /** Every layout once, every slot filled close to its budget: shows whether the budgets hold. */
  router.get("/templates/:id/sample.pptx", run(async (req, res) => {
    const stored = await found(param(req, "id"));
    if (stored.template.manifest.patterns.length === 0) throw new TemplateError(409, "This template has no layouts yet. Draft it first.");
    const items = req.query.items === "max" || req.query.items === "min" ? req.query.items : "drawn";
    let pptx: Uint8Array;
    try {
      const { deck, assets } = sampleDeck(stored.template, { items });
      pptx = renderDeck(stored.template, deck, { assets, layout: "adaptive" }).pptx;
    } catch (error) {
      throw new TemplateError(422, `The sample could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
    }
    attach(res, `${stored.id}.sample.pptx`);
    res.type(PPTX_TYPE).send(Buffer.from(pptx));
  }));

  /** A deck the chat tools made. The file is kept with the template it was made from. */
  router.get("/files/:templateId/:file", run(async (req, res) => {
    const deckId = /^(deck_[A-Za-z0-9]{6,40})\.pptx$/.exec(param(req, "file"))?.[1];
    if (!deckId) throw new TemplateError(404, "This presentation is not on the server.");
    const store = library.store(param(req, "templateId"));
    const pptx = await store.get(storeKeys.pptx(deckId));
    if (!pptx) throw new TemplateError(404, "This presentation is no longer on the server. Ask for it to be created again.");
    let title = "";
    try {
      const deck = await store.get(storeKeys.deck(deckId));
      title = deck ? ((JSON.parse(Buffer.from(deck).toString("utf8")) as DeckSpec).title ?? "") : "";
    } catch { /* The file is still good without its title. */ }
    attach(res, downloadName(title, "pptx"));
    res.type(PPTX_TYPE).send(Buffer.from(pptx));
  }));

  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status = error instanceof TemplateError ? error.status : typeof error?.status === "number" ? error.status : 500;
    const message = status === 413 && !(error instanceof TemplateError)
      ? `The file is larger than the ${Math.round(library.maxTemplateBytes / 1024 / 1024)} MB template limit.`
      : error instanceof Error ? error.message : "The request failed.";
    res.status(status).json({ error: message });
  };
  router.use(errors);
  return router;
}
