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
import { downloadName } from "./routes.js";
import { TemplateLibrary, deckFieldValues } from "./templates.js";

const DEMO_PPTX = path.resolve(process.cwd(), "presentation-templates", "demo", "template.pptx");
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

describe("Template Studio API", () => {
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
    expect(response.body.error).toContain("Template Studio");
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
