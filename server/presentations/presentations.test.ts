// @ts-nocheck -- Fetch doubles intentionally implement only the behavior under test.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "slotdeck";
import { createApp } from "../app.js";
import { resolveGeminiChatModels } from "../catalog.js";
import { contentWithPresentationNotes, PRESENTATION_NOTE_PREFIX } from "../../shared/chat-tools.js";
import { validateChatRequest } from "../chat/validation.js";
import { resolveVertexChatModels, resolveProbeRegions } from "../catalog.js";
import { nearestAspectRatio } from "./models.js";
import { SlidePictures } from "./previews.js";
import { downloadName } from "./routes.js";
import { TemplateLibrary, deckFieldValues } from "./templates.js";

const DEMO_PPTX = path.resolve(process.cwd(), "presentation-templates", "demo", "template.pptx");
const DEMO_MANIFEST = path.resolve(process.cwd(), "presentation-templates", "demo", "manifest.json");

/** Reads a response body as bytes. */
function binary(res, done) {
  const chunks = [];
  res.on("data", (chunk) => chunks.push(chunk));
  res.on("end", () => done(null, Buffer.concat(chunks)));
}
const MODEL = resolveGeminiChatModels()[0].id;

let directory;
let library;
let savedEnv;

beforeEach(async () => {
  savedEnv = { ...process.env };
  process.env.GEMINI_API_KEY = "test-key";
  // No photo source: decks are planned without photos, so no image model is ever called.
  process.env.PRESENTATIONS_PHOTOS = "0";
  delete process.env.PRESENTATIONS_MODEL;
  delete process.env.PRESENTATIONS_DEFAULT_TEMPLATE;
  directory = await mkdtemp(path.join(os.tmpdir(), "gemini-prep-presentations-"));
  library = new TemplateLibrary({ directory });
});

afterEach(async () => {
  process.env = savedEnv;
  await rm(directory, { recursive: true, force: true });
});

function sse(parts) {
  const encoder = new TextEncoder();
  const block = `data: ${JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] })}\n\n`;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(block));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/**
 * Stands in for Gemini. The chat model (Generate Content, streamed) gives the scripted turns in
 * order; slotdeck's model (the Interactions API) gives the scripted JSON answers in order, or
 * whatever `answer` works out from the request.
 */
function gemini({ chat = [], json = [], answer }: { chat?: unknown[][]; json?: unknown[]; answer?: (body) => unknown } = {}) {
  const calls = { chat: [], interactions: [], other: [] };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes(":streamGenerateContent")) {
      calls.chat.push(body);
      if (chat.length === 0) throw new Error("the scripted chat model has no turn left");
      return sse(chat.shift());
    }
    if (String(url).endsWith("/interactions")) {
      calls.interactions.push(body);
      const value = answer ? answer(body) : json.shift();
      if (value === undefined) throw new Error("the scripted model has no answer left");
      return Response.json({ status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(value) }] }] });
    }
    calls.other.push(String(url));
    throw new Error(`unexpected request to ${url}`);
  };
  return { fetchImpl, calls };
}

function events(text) {
  return text.split("\n\n").filter(Boolean).map((block) => ({
    event: block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim(),
    data: JSON.parse(block.split("\n").find((line) => line.startsWith("data:")).slice(5)),
  }));
}

function chatBody(extra = {}) {
  return { provider: "gemini", model: MODEL, temperature: 1, maxOutputTokens: 2048, tool: "presentation", messages: [{ role: "user", content: "A deck about bikes" }], ...extra };
}

const OUTLINE = { title: "City bikes", slides: [{ pattern: "cover", purpose: "Open the deck" }, { pattern: "closing", purpose: "Say thanks" }] };
const CONTENT = { s1: { title: "City bikes", subtitle: "A short tour" }, s2: { title: "Thank you" } };

describe("presentation templates", () => {
  it("ships a demo template that checks clean against its pptx", async () => {
    const [demo] = await library.list();
    expect(demo).toMatchObject({ id: "demo", builtIn: true });
    const detail = library.detail(demo);
    expect(detail).toMatchObject({ name: "Demo", slides: 13, patterns: 18, errors: 0, direction: "ltr" });
    expect(detail.view.slides).toHaveLength(13);
    expect(detail.fields).toEqual([expect.objectContaining({ name: "organizationDepartment", value: "Gemini Prep  |  Demo template" })]);
    expect((await library.icons(demo)).map((icon) => icon.id)).toContain("clock");
  });

  it("draws each layout from the shapes of its slide, without the shapes it always removes", async () => {
    const demo = await library.get("demo");
    const layouts = library.layouts(demo);
    expect(layouts.aspectRatio).toBeCloseTo(16 / 9, 1);
    expect(layouts.patterns.cover.shapes.filter((shape) => shape.fill === "text").map((shape) => shape.label))
      .toEqual(expect.arrayContaining(["title", "subtitle"]));
    // text-only is the photo slide with its photo dropped.
    expect(layouts.patterns["text-and-photo"].shapes.some((shape) => shape.fill === "image")).toBe(true);
    expect(layouts.patterns["text-only"].shapes.some((shape) => shape.fill === "image")).toBe(false);
  });

  it("gives every deck field a value: the studio's, or the template's own text", async () => {
    const copy = await library.duplicate("demo", "Mine");
    expect(deckFieldValues(copy).organizationDepartment).toBe("Gemini Prep  |  Demo template");
    const cleared = await library.saveMeta(copy.id, { fields: {} });
    expect(deckFieldValues(cleared).organizationDepartment).toMatch(/\S/);
    expect(deckFieldValues(cleared).organizationDepartment).not.toBe("Gemini Prep  |  Demo template");
  });

  it("keeps an uploaded pptx as a template without layouts, and refuses what is not a pptx", async () => {
    const bytes = new Uint8Array(await readFile(DEMO_PPTX));
    const created = await library.create({ name: "Quarterly Review!", bytes, sourceName: "review.pptx" });
    expect(created).toMatchObject({ id: "quarterly-review", builtIn: false });
    expect(library.summary(created)).toMatchObject({ slides: 13, patterns: 0, sourceName: "review.pptx" });
    expect((await library.create({ name: "Quarterly Review", bytes })).id).toBe("quarterly-review-2");
    await expect(library.create({ name: "Notes", bytes: new TextEncoder().encode("not a zip") })).rejects.toMatchObject({ status: 422 });
    // A template without layouts cannot make a deck, so the chat falls back to one that can.
    expect((await library.resolve("quarterly-review")).id).toBe("demo");
  });

  it("does not let a shipped template be changed or removed", async () => {
    const demo = await library.get("demo");
    await expect(library.saveManifest("demo", demo.template.manifest)).rejects.toMatchObject({ status: 403 });
    await expect(library.remove("demo")).rejects.toMatchObject({ status: 403 });
    expect(await library.get("../demo")).toBeUndefined();
  });
});

describe("PPTX Studio API", () => {
  it("lists, uploads, changes, samples and deletes a template", async () => {
    const app = createApp({ presentations: library });
    const listed = await request(app).get("/api/presentations/templates");
    expect(listed.body).toMatchObject({ defaultTemplate: "demo", photos: false });
    expect(listed.body.templates.map((template) => template.id)).toEqual(["demo"]);

    const uploaded = await request(app).post("/api/presentations/templates")
      .set("Content-Type", "application/octet-stream")
      .set("X-File-Name", encodeURIComponent("מצגת לדוגמה.pptx"))
      .set("X-Template-Name", encodeURIComponent("Sample deck"))
      .send(await readFile(DEMO_PPTX));
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({ id: "sample-deck", patterns: 0, sourceName: "מצגת לדוגמה.pptx" });

    // By hand: make slide 1 a layout, mark its title, then ask for something that cannot work.
    const changed = await request(app).post("/api/presentations/templates/sample-deck/changes").send({ changes: [
      { op: "addPattern", slide: 1, id: "Opening" },
      { op: "addSlot", pattern: "opening", shape: "5", role: "title" },
      { op: "addSlot", pattern: "opening", shape: "999", role: "title" },
    ] });
    expect(changed.status).toBe(200);
    expect(changed.body.applied).toHaveLength(2);
    expect(changed.body.rejected).toEqual([{ index: 2, reason: expect.stringContaining("no shape #999") }]);
    expect(changed.body.template.manifest.patterns[0]).toMatchObject({ id: "opening", sourceSlide: 1 });
    expect(changed.body.template.manifest.patterns[0].slots[0]).toMatchObject({ name: "title", kind: "text", shapeId: "5" });

    const sample = await request(app).get("/api/presentations/templates/sample-deck/sample.pptx").buffer(true).parse((res, done) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(sample.status).toBe(200);
    expect(sample.body.subarray(0, 2).toString()).toBe("PK");
    expect(sample.headers["content-disposition"]).toContain("sample-deck.sample.pptx");

    const manifest = await request(app).get("/api/presentations/templates/sample-deck/manifest.json");
    expect(JSON.parse(manifest.text).patterns).toHaveLength(1);

    expect((await request(app).delete("/api/presentations/templates/sample-deck")).body).toEqual({ deleted: true });
    expect((await request(app).get("/api/presentations/templates/sample-deck")).status).toBe(404);
  });

  it("refuses changes to a shipped template, a file that is not a pptx, and an unknown model", async () => {
    const app = createApp({ presentations: library });
    const changed = await request(app).post("/api/presentations/templates/demo/changes").send({ changes: [{ op: "removePattern", pattern: "cover" }] });
    expect(changed.status).toBe(403);
    expect(changed.body.error).toContain("Duplicate it");
    const uploaded = await request(app).post("/api/presentations/templates").set("Content-Type", "application/octet-stream").send(Buffer.from("hello"));
    expect(uploaded.status).toBe(422);
    const copy = await request(app).post("/api/presentations/templates/demo/duplicate").send({ name: "Demo copy" });
    expect(copy.status).toBe(201);
    const drafted = await request(app).post(`/api/presentations/templates/${copy.body.id}/draft`).send({ provider: "gemini", model: "not-a-model" });
    expect(drafted.status).toBe(400);
  });

  it("drafts a manifest from the measured shapes alone: no picture of a slide reaches the model", async () => {
    const model = gemini({
      answer: (body) => {
        const properties = body.response_format.schema.properties;
        if (properties.fields) return { language: "en", fields: [] };
        // Slide 12 is the layout; the model judges every other slide unusable.
        if (!body.input.startsWith("Slide 12 of 13")) return { usable: false, reason: "not a layout", id: "", description: "", figures: false, shapes: [] };
        const shapes = properties.shapes.items.properties.shape.enum;
        return {
          usable: true,
          reason: "a section divider",
          id: "Section Break",
          description: "Opens a new part of the deck.",
          figures: false,
          shapes: shapes.map((shape, index) => ({ shape, role: index === 0 ? "title" : "text", name: index === 0 ? "title" : `line${index}`, optional: index > 0 })),
        };
      },
    });
    const app = createApp({ presentations: library, fetchImpl: model.fetchImpl });
    const copy = await request(app).post("/api/presentations/templates/demo/duplicate").send({ name: "Draft me" });
    const drafted = await request(app).post(`/api/presentations/templates/${copy.body.id}/draft`).send({ provider: "gemini", model: MODEL });
    expect(drafted.status).toBe(200);
    const stream = events(drafted.text);
    expect(stream.filter((entry) => entry.event === "progress").at(-1).data).toMatchObject({ done: 13, total: 13 });
    const result = stream.find((entry) => entry.event === "result").data;
    expect(result.manifest.patterns.map((pattern) => pattern.id)).toEqual(["section-break"]);
    expect(result.skipped).toHaveLength(12);
    expect(result.draftedWith).toBe(MODEL);

    // One call about the deck and one per slide, each of them text only.
    expect(model.calls.interactions).toHaveLength(14);
    for (const call of model.calls.interactions) {
      expect(typeof call.input).toBe("string");
      expect(JSON.stringify(call)).not.toContain('"type":"image"');
      expect(call.model).toBe(MODEL);
    }
  });

  it("changes a manifest by instruction through the same checked operations", async () => {
    const model = gemini({ json: [{ changes: [{ op: "setSlot", pattern: "cover", shape: "", slot: "subtitle", values: [{ property: "empty", value: "error" }] }], note: "" }] });
    const app = createApp({ presentations: library, fetchImpl: model.fetchImpl });
    const copy = await request(app).post("/api/presentations/templates/demo/duplicate").send({ name: "Edit me" });
    const edited = await request(app).post(`/api/presentations/templates/${copy.body.id}/instruct`).send({ provider: "gemini", model: MODEL, instruction: "Make the cover subtitle required." });
    expect(edited.status).toBe(200);
    expect(edited.body.applied).toHaveLength(1);
    const subtitle = edited.body.template.manifest.patterns.find((pattern) => pattern.id === "cover").slots.find((slot) => slot.name === "subtitle");
    expect(subtitle.empty).toBeUndefined();
    expect(model.calls.interactions[0].input).toContain("Make the cover subtitle required.");
  });

  it("takes a whole manifest, as with a template that already has one, and says what is wrong with a bad one", async () => {
    const app = createApp({ presentations: library });
    const manifest = JSON.parse(await readFile(DEMO_MANIFEST, "utf8"));
    await request(app).post("/api/presentations/templates").set("Content-Type", "application/octet-stream").set("X-Template-Name", "Brought in").send(await readFile(DEMO_PPTX));

    const saved = await request(app).put("/api/presentations/templates/brought-in/manifest").send({ ...manifest, name: "Brought in" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ id: "brought-in", name: "Brought in", patterns: 18, errors: 0 });

    // A manifest that is one, and does not match the pptx: kept, with the mismatch among the checks.
    const broken = structuredClone(manifest);
    broken.patterns[0].slots[0].shapeId = "999";
    const mismatched = await request(app).put("/api/presentations/templates/brought-in/manifest").send(broken);
    expect(mismatched.status).toBe(200);
    expect(mismatched.body.errors).toBe(1);
    expect(mismatched.body.issues.find((issue) => issue.severity === "error").message).toContain("shape #999");

    for (const [bad, message] of [
      [[], "A manifest is a JSON object."],
      [{ ...manifest, version: 2 }, '"version": 1'],
      [{ ...manifest, direction: "up" }, '"direction" is "ltr" or "rtl".'],
      [{ ...manifest, patterns: [{ ...manifest.patterns[0], id: "Cover Slide" }] }, "lowercase letters, digits and dashes"],
      [{ ...manifest, patterns: [manifest.patterns[0], manifest.patterns[0]] }, 'Two patterns are called "cover".'],
      [{ ...manifest, patterns: [{ ...manifest.patterns[0], slots: [{ name: "title", kind: "text", shapeId: 5 }] }] }, 'such as "5"'],
    ]) {
      const refused = await request(app).put("/api/presentations/templates/brought-in/manifest").send(bad);
      expect(refused.status).toBe(422);
      expect(refused.body.error).toContain(message);
    }
    // Nothing a refused manifest said was kept.
    expect((await request(app).get("/api/presentations/templates/brought-in")).body.manifest.patterns[0].slots[0].shapeId).toBe("999");
    expect((await request(app).put("/api/presentations/templates/demo/manifest").send(manifest)).status).toBe(403);
  });

  it("puts another pptx in a template's place and keeps the manifest", async () => {
    const app = createApp({ presentations: library });
    const copy = await request(app).post("/api/presentations/templates/demo/duplicate").send({ name: "Second edition" });
    const replaced = await request(app).put(`/api/presentations/templates/${copy.body.id}/pptx`)
      .set("Content-Type", "application/octet-stream").set("X-File-Name", "edition-2.pptx").send(await readFile(DEMO_PPTX));
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ patterns: 18, errors: 0, sourceName: "edition-2.pptx" });
    const refused = await request(app).put(`/api/presentations/templates/${copy.body.id}/pptx`).set("Content-Type", "application/octet-stream").send(Buffer.from("not a deck"));
    expect(refused.status).toBe(422);
    expect((await request(app).put("/api/presentations/templates/demo/pptx").set("Content-Type", "application/octet-stream").send(await readFile(DEMO_PPTX))).status).toBe(403);
  });

  it("derives variants, widens rows and scales body text through the checked operations", async () => {
    const app = createApp({ presentations: library });
    // The shipped manifest already has the mirror image of its photo layouts.
    const offered = await request(app).get("/api/presentations/templates/demo/patterns/list-with-photo/variants");
    expect(offered.status).toBe(200);
    expect(offered.body.variants.map((option) => option.variant)).toEqual(expect.arrayContaining(["mirror", "text-only"]));
    const cover = await request(app).get("/api/presentations/templates/demo/patterns/cover/variants");
    expect(cover.body.variants.find((option) => option.variant === "mirror")).toMatchObject({ available: false, note: expect.stringMatching(/\S/) });
    expect((await request(app).get("/api/presentations/templates/demo/patterns/no-such/variants")).status).toBe(404);

    const copy = await request(app).post("/api/presentations/templates/demo/duplicate").send({ name: "Variants" });
    const changed = await request(app).post(`/api/presentations/templates/${copy.body.id}/changes`).send({ changes: [
      { op: "derivePattern", pattern: "list-with-photo", variant: "text-only" },
      { op: "derivePattern", pattern: "cover", variant: "mirror" },
      { op: "setRepeat", pattern: "two-columns", widen: 1.5 },
      { op: "setManifest", textScale: 1.3 },
    ] });
    expect(changed.status).toBe(200);
    expect(changed.body.rejected.map((entry) => entry.index)).toEqual([1]);
    const { manifest } = changed.body.template;
    expect(manifest.patterns.map((pattern) => pattern.id)).toContain("list-with-photo-text-only");
    expect(manifest.patterns.find((pattern) => pattern.id === "two-columns").repeat.widen).toBe(1.5);
    expect(manifest.textScale).toBe(1.3);
  });

  it("draws pictures of a template's slides and layouts, to be shown as images only", async () => {
    const app = createApp({ presentations: library });
    expect((await request(app).get("/api/presentations/templates")).body.pictures).toBe(true);
    for (const url of ["/api/presentations/templates/demo/slides/2.svg", "/api/presentations/templates/demo/patterns/text-only.svg"]) {
      const picture = await request(app).get(url).buffer(true).parse(binary);
      expect(picture.status).toBe(200);
      expect(picture.headers["content-type"]).toContain("image/svg+xml");
      // A picture is made from an uploaded file: opened by itself, it may run and load nothing.
      expect(picture.headers["content-security-policy"]).toContain("sandbox");
      expect(picture.headers["x-content-type-options"]).toBe("nosniff");
      const svg = picture.body.toString("utf8");
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).not.toMatch(/<script/i);
    }
    // The text-only layout is drawn as itself: without the photo of the slide it was made from.
    const slide = (await request(app).get("/api/presentations/templates/demo/slides/2.svg").buffer(true).parse(binary)).body.toString("utf8");
    const layout = (await request(app).get("/api/presentations/templates/demo/patterns/text-only.svg").buffer(true).parse(binary)).body.toString("utf8");
    const images = (svg) => svg.match(/<image /g)?.length ?? 0;
    expect(images(slide)).toBe(2); // the logo and the photo
    expect(images(layout)).toBe(1); // the logo
    expect(layout).toContain("Slide title for a text and photo layout");
    for (const url of ["/api/presentations/templates/demo/slides/99.svg", "/api/presentations/templates/demo/slides/x.svg", "/api/presentations/templates/demo/patterns/none.svg"]) {
      expect((await request(app).get(url)).status).toBe(404);
    }
  });

  it("answers that there is no picture when the server draws none, so the browser draws boxes", async () => {
    const app = createApp({ presentations: library, slidePictures: new SlidePictures(async () => undefined) });
    expect((await request(app).get("/api/presentations/templates")).body.pictures).toBe(false);
    expect((await request(app).get("/api/presentations/templates/demo/slides/1.svg")).status).toBe(404);
    // The boxes come from the layouts, which need no renderer.
    expect((await request(app).get("/api/presentations/templates/demo/layouts")).body.patterns.cover.shapes.length).toBeGreaterThan(0);
  });

  it("draws a set of pictures once, and again only after a failure", async () => {
    let drawn = 0;
    let fail = true;
    const pictures = new SlidePictures(async () => ({
      async renderSlides() {
        drawn++;
        if (fail) throw new Error("renderer down");
        return [{ slide: 1, mimeType: "image/svg+xml", data: new TextEncoder().encode("<svg/>") }];
      },
    }));
    const demo = await library.get("demo");
    await expect(pictures.templateSlide(library, demo, 1)).rejects.toThrow("renderer down");
    fail = false;
    expect((await pictures.templateSlide(library, demo, 1)).data.toString()).toBe("<svg/>");
    expect(await pictures.templateSlide(library, demo, 2)).toBeUndefined();
    expect(drawn).toBe(2);
  });
});

describe("presentation tools in the chat", () => {
  it("plans a deck, then creates it from the plan the note names, and serves the file", async () => {
    const planning = gemini({
      chat: [
        [{ functionCall: { name: TOOL_NAMES.plan, args: { topic: "City bikes for new riders", slide_count: 2 } } }],
        [{ text: "Here is a two-slide plan. Create it?" }],
      ],
      json: [OUTLINE],
    });
    const app = createApp({ presentations: library, fetchImpl: planning.fetchImpl });
    const planned = await request(app).post("/api/chat/stream").send(chatBody());
    expect(planned.status).toBe(200);
    const planEvents = events(planned.text);
    expect(planEvents.map((entry) => entry.event)).toEqual(expect.arrayContaining(["meta", "activity", "presentation", "step", "delta", "done"]));
    const plan = planEvents.find((entry) => entry.event === "presentation").data;
    expect(plan).toMatchObject({ kind: "plan", templateId: "demo", templateName: "Demo", title: "City bikes" });
    expect(plan.slides).toEqual([
      { number: 1, layout: "cover", purpose: "Open the deck" },
      { number: 2, layout: "closing", purpose: "Say thanks" },
    ]);
    expect(planEvents.find((entry) => entry.event === "step").data.text).toBe("Planning the presentation — 2 slides: City bikes");

    // The chat model gets slotdeck's four tools and the guidance, and then the tool's small result.
    const [first, second] = planning.calls.chat;
    expect(first.tools[0].functionDeclarations.map((tool) => tool.name)).toEqual(Object.values(TOOL_NAMES));
    expect(first.systemInstruction.parts[0].text).toContain(`A new presentation starts with ${TOOL_NAMES.plan}`);
    expect(first.systemInstruction.parts[0].text).toContain('The template is "Demo"');
    expect(second.contents.at(-1).parts[0].functionResponse).toMatchObject({ name: TOOL_NAMES.plan, response: { plan_id: plan.id } });
    // Photos are off, so the planner is told to plan none.
    expect(planning.calls.interactions[0].input).toContain("Do not plan any photos.");

    // Next turn: the browser sends the plan back as a note with the assistant's text.
    const creating = gemini({
      chat: [
        [{ functionCall: { name: TOOL_NAMES.create, args: { plan_id: plan.id } } }],
        [{ text: "The presentation is ready." }],
      ],
      json: [CONTENT],
    });
    const created = await request(createApp({ presentations: library, fetchImpl: creating.fetchImpl })).post("/api/chat/stream").send(chatBody({
      messages: [
        { role: "user", content: "A deck about bikes" },
        { role: "assistant", content: contentWithPresentationNotes("Here is a two-slide plan. Create it?", [plan]) },
        { role: "user", content: "Approved. Create the presentation." },
      ],
    }));
    const deck = events(created.text).find((entry) => entry.event === "presentation").data;
    expect(deck).toMatchObject({ kind: "deck", templateId: "demo", title: "City bikes" });
    expect(deck.slides).toEqual([
      { number: 1, layout: "cover", title: "City bikes" },
      { number: 2, layout: "closing", title: "Thank you" },
    ]);
    expect(deck.file).toBe(`/api/presentations/files/demo/${deck.id}.pptx`);
    expect(creating.calls.chat[0].contents[1].parts[0].text).toContain(`${PRESENTATION_NOTE_PREFIX} {"tool":"${TOOL_NAMES.plan}","plan_id":"${plan.id}"`);
    expect(JSON.parse(deck.context)).toMatchObject({ presentation_id: deck.id, from_plan_id: plan.id });

    const file = await request(app).get(deck.file).buffer(true).parse((res, done) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.body.length).toBe(deck.bytes);
    expect(file.body.subarray(0, 2).toString()).toBe("PK");
    expect(file.headers["content-disposition"]).toContain('filename="City bikes.pptx"');
    // The slides of the deck as pictures, drawn from the file for the card in the chat.
    const slide = await request(app).get(`${deck.file.replace(/\.pptx$/, "")}/slides/1.svg`).buffer(true).parse(binary);
    expect(slide.status).toBe(200);
    expect(slide.headers["content-type"]).toContain("image/svg+xml");
    expect(slide.body.toString("utf8")).toContain("City bikes");
    expect((await request(app).get(`${deck.file.replace(/\.pptx$/, "")}/slides/3.svg`)).status).toBe(404);
    expect((await request(app).get("/api/presentations/files/demo/deck_0000000000/slides/1.svg")).status).toBe(404);
    expect((await request(app).get("/api/presentations/files/demo/deck_0000000000.pptx")).status).toBe(404);
    expect((await request(app).get("/api/presentations/files/demo/..%2Fdeck.pptx")).status).toBe(404);
  });

  it("tells the model in words when a tool cannot do what it asked", async () => {
    const model = gemini({
      chat: [
        [{ functionCall: { name: TOOL_NAMES.create, args: { plan_id: "plan_missing00" } } }],
        [{ text: "I could not find that plan." }],
      ],
    });
    const response = await request(createApp({ presentations: library, fetchImpl: model.fetchImpl })).post("/api/chat/stream").send(chatBody());
    const stream = events(response.text);
    expect(stream.some((entry) => entry.event === "presentation")).toBe(false);
    expect(stream.find((entry) => entry.event === "step").data.text).toContain('failed: There is no plan with id "plan_missing00"');
    expect(model.calls.chat[1].contents.at(-1).parts[0].functionResponse.response.error).toContain("plan_missing00");
    expect(stream.at(-1).event).toBe("done");
  });

  it("works on a plan with the template it was made with, whichever the browser names now", async () => {
    const planning = gemini({
      chat: [[{ functionCall: { name: TOOL_NAMES.plan, args: { topic: "City bikes", slide_count: 2 } } }], [{ text: "Planned." }]],
      json: [OUTLINE],
    });
    const copy = await library.duplicate("demo", "Second");
    const planned = await request(createApp({ presentations: library, fetchImpl: planning.fetchImpl })).post("/api/chat/stream")
      .send(chatBody({ presentationTemplate: copy.id }));
    const plan = events(planned.text).find((entry) => entry.event === "presentation").data;
    expect(plan.templateId).toBe(copy.id);

    const creating = gemini({
      chat: [[{ functionCall: { name: TOOL_NAMES.create, args: { plan_id: plan.id } } }], [{ text: "Done." }]],
      json: [CONTENT],
    });
    const created = await request(createApp({ presentations: library, fetchImpl: creating.fetchImpl })).post("/api/chat/stream")
      .send(chatBody({ presentationTemplate: "demo" }));
    expect(events(created.text).find((entry) => entry.event === "presentation").data).toMatchObject({ kind: "deck", templateId: copy.id });
  });

  it("is handed the turn by the chat model when tools are on Auto", async () => {
    const model = gemini({
      chat: [
        [{ functionCall: { name: "make_presentation", args: { request: "a deck about bikes" } } }],
        [{ functionCall: { name: TOOL_NAMES.plan, args: { topic: "City bikes", slide_count: 2 } } }],
        [{ text: "Here is the plan." }],
      ],
      json: [OUTLINE],
    });
    const response = await request(createApp({ presentations: library, fetchImpl: model.fetchImpl })).post("/api/chat/stream")
      .send(chatBody({ tool: undefined }));
    const stream = events(response.text);
    expect(stream.filter((entry) => entry.event === "meta")).toHaveLength(1);
    expect(stream.find((entry) => entry.event === "tool").data).toMatchObject({ id: "presentation", name: "make_presentation" });
    expect(stream.find((entry) => entry.event === "presentation").data.kind).toBe("plan");
    expect(stream.at(-1).event).toBe("done");
    // The first model chose among the app's tools; the second got slotdeck's and the user's own words.
    expect(model.calls.chat[0].tools[0].functionDeclarations.map((tool) => tool.name)).toContain("make_presentation");
    expect(model.calls.chat[1].tools[0].functionDeclarations.map((tool) => tool.name)).toEqual(Object.values(TOOL_NAMES));
    expect(model.calls.chat[1].contents.at(-1).parts[0].text).toBe("A deck about bikes");
  });

  it("answers without tools once the rounds of tool calls are used up", async () => {
    process.env.PRESENTATIONS_MAX_TOOL_TURNS = "2";
    const model = gemini({
      chat: [
        [{ functionCall: { name: TOOL_NAMES.create, args: { plan_id: "plan_missing00" } } }],
        [{ text: "That plan is gone." }],
      ],
    });
    const response = await request(createApp({ presentations: library, fetchImpl: model.fetchImpl })).post("/api/chat/stream").send(chatBody());
    expect(model.calls.chat[0]).toHaveProperty("tools");
    expect(model.calls.chat[1]).not.toHaveProperty("tools");
    expect(response.text).toContain("That plan is gone.");
  });

  it("says so before streaming when no template can make a deck", async () => {
    const empty = new TemplateLibrary({ directory, builtInDirectory: path.join(directory, "none") });
    const response = await request(createApp({ presentations: empty, fetchImpl: gemini().fetchImpl })).post("/api/chat/stream").send(chatBody());
    expect(response.status).toBe(409);
    expect(response.body.error).toContain("PPTX Studio");
  });
});

describe("presentation request details", () => {
  const catalogs = () => ({ vertexModels: resolveVertexChatModels(), geminiModels: resolveGeminiChatModels(), regions: resolveProbeRegions() });

  it("accepts the presentation tool and a template id, and rejects a malformed id", () => {
    expect(validateChatRequest(chatBody({ presentationTemplate: "my-template" }), catalogs())).toMatchObject({ tool: "presentation", presentationTemplate: "my-template" });
    expect(() => validateChatRequest(chatBody({ presentationTemplate: "../etc" }), catalogs())).toThrow("Invalid presentationTemplate.");
    expect(() => validateChatRequest(chatBody({ tool: "slides" }), catalogs())).toThrow("tool must be image, graph or presentation.");
  });

  it("adds a note per plan or deck to the text a message is replayed with", () => {
    expect(contentWithPresentationNotes("Plain answer.", undefined)).toBe("Plain answer.");
    expect(contentWithPresentationNotes("", [{ context: '{"plan_id":"plan_1"}' }])).toBe(`${PRESENTATION_NOTE_PREFIX} {"plan_id":"plan_1"}`);
    expect(contentWithPresentationNotes("Done.", [{ context: "a" }, { context: "b" }])).toBe(`Done.\n\n${PRESENTATION_NOTE_PREFIX} a\n\n${PRESENTATION_NOTE_PREFIX} b`);
  });

  it("picks the nearest supported photo ratio and a safe download name", () => {
    expect(nearestAspectRatio(1.8)).toBe("16:9");
    expect(nearestAspectRatio(0.5)).toBe("9:16");
    expect(nearestAspectRatio(1)).toBe("1:1");
    expect(downloadName('Q3: plans / "risks"?', "pptx")).toBe("Q3 plans risks.pptx");
    expect(downloadName("  ", "pptx")).toBe("presentation.pptx");
    expect(downloadName("תוכנית רבעונית", "pptx")).toBe("תוכנית רבעונית.pptx");
  });
});
