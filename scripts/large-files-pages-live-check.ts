// Live check of page views in this app: a PDF kept on the server, questions that only its pictures
// answer, and Gemini looking at the pages through the app's own upload and chat routes.
//
//   npm run check:large-files-pages              # Vertex AI, then the Gemini Developer API
//   npm run check:large-files-pages -- vertex    # only Vertex AI
//   npm run check:large-files-pages -- gemini    # only the Gemini Developer API
//
// Each provider answers with the pages inside the function response, as the app sends them, and
// once with the PDF treated as too large to send whole. The same questions are then asked with the
// pages beside the function response (LARGE_FILES_PAGE_PLACEMENT=beside), to show what that
// setting would do: Vertex AI refuses it for Gemini 3 models, so those runs only report.
// Model: CHECK_MODEL (default gemini-3.5-flash-lite). Vertex region: CHECK_REGION (default global).
// CHECK_THINKING=none leaves the thinking level out, which Gemini 2.5 needs.
// CHECK_PDF and CHECK_QUESTION ask your own question about your own PDF instead; CHECK_EXPECT is
// text the answer should hold.
//
// About 15 small, billable requests per provider. Credentials are never printed.
// Lines marked "·" report what the model did or said and never fail the run: a cheap model can
// look at the right page and still misread it.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { config } from "dotenv";

// The settings come from .env here, or from the main checkout when this runs in a git worktree.
for (const candidate of [path.resolve(".env"), path.resolve("..", "..", "..", ".env")]) {
  if (existsSync(candidate)) {
    config({ path: candidate, quiet: true });
    break;
  }
}
// The check keeps its uploads in a folder of its own, removed at the end.
const directory = await mkdtemp(path.join(tmpdir(), "gemini-prep-pages-check-"));
process.env.LARGE_FILES_DIR = directory;
delete process.env.LARGE_FILES_KEEP_PDFS;
delete process.env.LARGE_FILES_INLINE_TOKENS;

// After the settings: the server reads them from the environment.
const { createApp } = await import("../server/app.js");
const { resolveGeminiChatModels, resolveProbeRegions, resolveVertexChatModels, resolveVertexProject } = await import("../server/catalog.js");
const { createServerLargeFiles } = await import("../server/documents/config.js");
const { getVertexAccessToken } = await import("../server/vertex-auth.js");

type Json = Record<string, any>;
type ProviderId = "vertex" | "gemini";
type ModelCall = { status: number; body: Json; usage: Promise<Json | undefined> };
type StreamEvent = { event: string; data: Json };

const MODEL = process.env.CHECK_MODEL ?? "gemini-3.5-flash-lite";
/** The chat's thinking level, as the chat page sends it. Gemini 2.5 refuses one: CHECK_THINKING=none. */
const THINKING = process.env.CHECK_THINKING ?? "low";
const CHART_PAGE = 3;
const SIGN_PAGE = 10;
const PAGES = 12;
let failures = 0;
const ok = (message: string) => console.log(`  ✓ ${message}`);
const failed = (message: string) => { failures++; console.log(`  ✗ ${message}`); };
/** What the model did or said: reported, never failed. */
const info = (message: string) => console.log(`  · ${message}`);
const count = (value: number) => value.toLocaleString("en-US");
const oneLine = (text: string, most = 220) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > most ? `${flat.slice(0, most)}…` : flat;
};

/** An RGB PNG, one colour per pixel. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (1 + width * 3) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * A twelve-page report. Page 3 holds a bar chart drawn as shapes (South is the tallest bar) and
 * page 10 a photo of a sign (a purple disc). Its text names the figures and the regions, and
 * says nothing about which bar is tallest or what the sign shows.
 */
async function reportPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const sign = await document.embedPng(png(300, 300, (x, y) => {
    if (x < 8 || y < 8 || x >= 292 || y >= 292) return [0, 0, 0];
    return (x - 150) ** 2 + (y - 150) ** 2 <= 100 ** 2 ? [128, 0, 160] : [255, 255, 255];
  }));
  for (let number = 1; number <= PAGES; number++) {
    const page = document.addPage([595, 842]);
    const heading = (text: string) => page.drawText(text, { x: 60, y: 760, size: 18, font: bold });
    const line = (text: string, row: number) => page.drawText(text, { x: 60, y: 720 - row * 20, size: 11, font });
    if (number === CHART_PAGE) {
      heading("Figure 1: Sales by region");
      line("The chart below compares the four regions of the company.", 0);
      const bars: Array<[string, number, [number, number, number]]> = [["North", 150, [0.15, 0.4, 0.8]], ["South", 260, [0.85, 0.3, 0.2]], ["East", 110, [0.2, 0.65, 0.3]], ["West", 200, [0.9, 0.7, 0.1]]];
      bars.forEach(([name, height, [r, g, b]], index) => {
        page.drawRectangle({ x: 110 + index * 100, y: 380, width: 60, height, color: rgb(r, g, b) });
        page.drawText(name, { x: 118 + index * 100, y: 360, size: 12, font });
      });
      page.drawLine({ start: { x: 90, y: 380 }, end: { x: 520, y: 380 }, thickness: 1.5, color: rgb(0, 0, 0) });
    } else if (number === SIGN_PAGE) {
      heading("Figure 2: The sign at the gate");
      line("A photo of the sign follows.", 0);
      page.drawImage(sign, { x: 177, y: 360, width: 240, height: 240 });
    } else {
      heading(`Section ${number}`);
      line(`These are the notes of section ${number} of the report. They hold text only.`, 0);
      line("The work went on as planned, and nothing in this section needs a decision.", 1);
      line("The next review of these notes is due at the end of the quarter.", 2);
    }
  }
  return document.save();
}

/** A fetch that keeps what the app sent to the model and what came back. */
function recorder() {
  const calls: ModelCall[] = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const usage = response.clone().text().then((text) => {
      // A stream is server-sent JSON, one chunk per data line; the last usage block is the total.
      let last: Json | undefined;
      for (const row of text.split("\n")) {
        if (!row.startsWith("data:")) continue;
        try {
          const chunk = JSON.parse(row.slice(5)) as Json;
          if (chunk.usageMetadata) last = chunk.usageMetadata;
        } catch { /* not a whole JSON line */ }
      }
      if (last) return last;
      try {
        return (JSON.parse(text) as Json).usageMetadata as Json | undefined;
      } catch {
        return undefined;
      }
    }, () => undefined);
    calls.push({ status: response.status, body: JSON.parse(String(init?.body ?? "{}")) as Json, usage });
    return response;
  };
  return { calls, fetch: recording };
}

function parseEvents(text: string): StreamEvent[] {
  return text.split("\n\n").filter((block) => block.trim()).map((block) => ({
    event: /^event: (.+)$/m.exec(block)?.[1] ?? "",
    data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "null") as Json,
  }));
}

/** Starts the app on a free local port. */
async function serve(recording: typeof fetch) {
  const app = createApp({ largeFiles: createServerLargeFiles("npm"), fetchImpl: recording });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

type Scenario = { title: string; placement: "inside" | "beside"; question: string; expect: Array<[string, RegExp]>; looksNeeded: number; searches?: boolean };

async function runScenario(provider: ProviderId, region: string | undefined, documentId: string, name: string, scenario: Scenario) {
  console.log(`\n  ${scenario.title}`);
  // The app sends pages inside the function response. The other placement is shown, not required.
  const required = scenario.placement === "inside";
  const fail = required ? failed : info;
  const check = (passed: boolean, message: string, detail = "") => passed ? ok(message) : fail(`${message}${detail ? ` — ${detail}` : ""}`);
  process.env.LARGE_FILES_PAGE_PLACEMENT = scenario.placement;
  // The budget is read when the library is created: a tiny one makes the PDF "too large to send whole".
  if (scenario.searches) process.env.LARGE_FILES_INLINE_TOKENS = "100";
  else delete process.env.LARGE_FILES_INLINE_TOKENS;
  const record = recorder();
  const app = await serve(record.fetch);
  let events: StreamEvent[] = [];
  let status = 0;
  try {
    const response = await fetch(`${app.base}/api/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        model: MODEL,
        ...(region ? { region } : {}),
        temperature: 1,
        maxOutputTokens: 8192,
        ...(THINKING === "low" || THINKING === "high" ? { thinkingLevel: THINKING } : {}),
        messages: [{ role: "user", content: scenario.question, files: [{ kind: "document", name, mimeType: "application/pdf", documentId }] }],
      }),
    });
    status = response.status;
    const text = await response.text();
    if (status !== 200) {
      fail(`the chat was refused: HTTP ${status} ${oneLine(text)}`);
      return;
    }
    events = parseEvents(text);
  } finally {
    await app.close();
  }

  const error = events.find((event) => event.event === "error");
  const statuses = record.calls.map((call) => call.status);
  if (error) {
    fail(`the chat ended with an error after ${record.calls.length} model requests (HTTP ${statuses.join(", ")}): ${oneLine(String(error.data.message), 400)}`);
  } else {
    check(events.at(-1)?.event === "done" && statuses.every((code) => code === 200), `the chat finished: ${record.calls.length} model requests, HTTP ${statuses.join(", ")}`);
  }

  // What the app sent: the last request holds the whole exchange.
  const first = record.calls[0]?.body;
  const tools = (first?.tools?.[0]?.functionDeclarations ?? []).map((tool: Json) => tool.name).join(", ");
  info(`tools declared: ${tools || "none"}`);
  const prompt = (first?.contents?.[0]?.parts ?? []).map((part: Json) => part.text ?? "").join("\n");
  const marked = [...prompt.matchAll(/--- Page (\d+) ---\r?\n(?:\s*\d+\| )?\[Picture on this page/g)].map((match) => match[1]);
  if (!scenario.searches) info(`pages the text marks as pictures: ${marked.join(", ") || "none"}`);

  const contents: Json[] = record.calls.at(-1)?.body.contents ?? [];
  const turns = contents.filter((content) => content.role === "model")
    .map((content) => (content.parts as Json[]).filter((part) => part.functionCall?.name === "view_pages").length)
    .filter((looks) => looks > 0);
  const answers = contents.flatMap((content) => (content.parts as Json[] ?? [])).filter((part) => part.functionResponse?.name === "view_pages");
  const shown = answers.filter((part) => part.functionResponse.response?.file);
  const inside = answers.flatMap((part) => (part.functionResponse.parts ?? []) as Json[]).filter((part) => part.inlineData?.mimeType === "application/pdf");
  const beside = contents.filter((content) => content.role === "user").flatMap((content) => content.parts as Json[]).filter((part) => part.inlineData?.mimeType === "application/pdf");
  const steps = events.filter((event) => event.event === "step").map((event) => String(event.data.text));
  const looks = steps.filter((step) => step.startsWith(`Look at ${name}`));

  if (shown.length === 0) {
    fail(`the model never looked at a page, so this run checked nothing (steps: ${steps.join("; ") || "none"})`);
  } else {
    ok(`looks shown as steps: ${looks.map((step) => `"${step}"`).join(", ")}`);
    const files = scenario.placement === "inside" ? inside : beside;
    const bytes = files.reduce((sum, part) => sum + Math.floor(String(part.inlineData.data).length * 3 / 4), 0);
    check(files.length === shown.length && (scenario.placement === "inside" ? beside : inside).length === 0,
      `the pages went ${scenario.placement} the function response: ${files.length} PDF${files.length === 1 ? "" : "s"}, ${count(bytes)} bytes`,
      `${inside.length} inside, ${beside.length} beside, for ${shown.length} looks`);
    info(turns.some((looksInTurn) => looksInTurn > 1)
      ? `looks per model turn: ${turns.join(", ")} (more than one look in a single turn)`
      : `looks per model turn: ${turns.join(", ")}`);
    if (shown.length < scenario.looksNeeded) info(`the question needs ${scenario.looksNeeded} looks; the model made ${shown.length}`);
  }
  const refused = answers.filter((part) => part.functionResponse.response?.error);
  for (const part of refused) info(`a look was refused: ${oneLine(String(part.functionResponse.response.error))}`);
  // No answer to judge when the model provider refused the request.
  if (error) return;

  // Gemini 3 counts the pages of a PDF under the IMAGE modality, Gemini 2.5 under DOCUMENT.
  const usages = await Promise.all(record.calls.map((call) => call.usage));
  const pageTokens = usages.map((usage) => ((usage?.promptTokensDetails ?? []) as Json[])
    .filter((detail) => detail.modality !== "TEXT").reduce((sum, detail) => sum + Number(detail.tokenCount ?? 0), 0));
  info(`input tokens per request: ${usages.map((usage) => count(Number(usage?.promptTokenCount ?? 0))).join(", ")}; of them for pages: ${pageTokens.map((tokens) => count(tokens)).join(", ")}`);

  const answer = events.filter((event) => event.event === "delta").map((event) => String(event.data.text)).join("");
  for (const [what, pattern] of scenario.expect) info(`${pattern.test(answer) ? "right" : "WRONG"}: ${what}`);
  info(`answer: ${oneLine(answer, 400)}`);
}

async function runProvider(provider: ProviderId) {
  const vertex = provider === "vertex";
  let region: string | undefined;
  if (vertex) {
    const regions = resolveProbeRegions().map((option) => option.id);
    region = process.env.CHECK_REGION ?? (regions.includes("global") ? "global" : regions[0]);
  }
  console.log(`\n${vertex ? "Vertex AI" : "Gemini Developer API"} · ${MODEL}${region ? ` · ${region}` : ""}`);
  if (vertex) {
    if (!resolveVertexProject(null).project) return failed("no Google Cloud project is configured (GCP_PROJECT)");
    try {
      await getVertexAccessToken();
    } catch (error) {
      return failed(`no Vertex AI access token: ${oneLine(error instanceof Error ? error.message : String(error))}`);
    }
  } else if (!process.env.GEMINI_API_KEY) {
    return failed("GEMINI_API_KEY is not configured");
  }
  // The check's model joins the chat catalog for this run only.
  const models = (vertex ? resolveVertexChatModels() : resolveGeminiChatModels()).map((option) => option.id);
  if (!models.includes(MODEL)) process.env[vertex ? "VERTEX_CHAT_MODELS" : "GEMINI_CHAT_MODELS"] = [...models, MODEL].join(",");

  const own = process.env.CHECK_PDF;
  const name = own ? path.basename(own) : "report.pdf";
  const bytes = own ? await readFile(own) : Buffer.from(await reportPdf());
  const app = await serve(fetch);
  let uploaded: Json;
  try {
    const response = await fetch(`${app.base}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), "X-File-Type": "application/pdf" },
      body: bytes,
    });
    uploaded = (await response.json()) as Json;
    if (response.status !== 201) return failed(`the upload was refused: HTTP ${response.status} ${oneLine(String(uploaded.error))}`);
  } finally {
    await app.close();
  }
  ok(`${name} uploaded: ${count(bytes.length)} bytes, ${uploaded.pages} pages, about ${count(uploaded.estimatedTokens)} tokens of text; the PDF is kept: ${existsSync(path.join(directory, `${uploaded.id}.bin`)) ? "yes" : "NO"}`);

  const chart = "Which region has the tallest bar in Figure 1 of the report? Answer with the name of the region.";
  const both = "Two things from the report: which region has the tallest bar in Figure 1, and what colour is the disc on the sign in Figure 2?";
  const south: [string, RegExp] = ["the tallest bar is South", /\bsouth\b/i];
  const purple: [string, RegExp] = ["the disc is purple", /purple|violet|magenta/i];
  const wanted = process.env.CHECK_EXPECT;
  const scenarios: Scenario[] = own
    ? (["inside", "beside"] as const).map((placement) => ({
        title: `Your question, pages ${placement} the function response`, placement, looksNeeded: 1,
        question: process.env.CHECK_QUESTION ?? "What do the pictures in this file show?",
        expect: wanted ? [[`the answer holds "${wanted}"`, new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")] as [string, RegExp]] : [],
      }))
    : [
        { title: "One figure", placement: "inside", question: chart, expect: [south], looksNeeded: 1 },
        { title: "Two figures seven pages apart", placement: "inside", question: both, expect: [south, purple], looksNeeded: 2 },
        { title: "A PDF too large to send whole: search, then look", placement: "inside", question: chart, expect: [south], looksNeeded: 1, searches: true },
        { title: "One figure, pages beside the function response", placement: "beside", question: chart, expect: [south], looksNeeded: 1 },
        { title: "Two figures seven pages apart, pages beside the function response", placement: "beside", question: both, expect: [south, purple], looksNeeded: 2 },
      ];
  for (const scenario of scenarios) await runScenario(provider, region, uploaded.id, name, scenario);
}

try {
  const only = process.argv[2];
  if (only && only !== "vertex" && only !== "gemini") throw new Error(`Unknown provider "${only}": use vertex or gemini.`);
  const version = (JSON.parse(await readFile(path.resolve("node_modules", "llm-large-files", "package.json"), "utf8")) as { version: string }).version;
  console.log(`Page views through the app's own routes · llm-large-files ${version}`);
  for (const provider of ["vertex", "gemini"] as const) {
    if (!only || only === provider) await runProvider(provider);
  }
  console.log(failures ? `\n${failures} failed.` : "\nAll checks passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
  process.exitCode = failures ? 1 : 0;
}
