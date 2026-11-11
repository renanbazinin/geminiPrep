// Live check of an explorer model in this app (LARGE_FILES_EXPLORER_MODEL): a log and a PDF kept
// on the server, questions asked through the app's own upload and chat routes, and a second model
// doing the searching and reading while the chat's model writes the answer.
//
//   npm run check:large-files-explorer              # Vertex AI, then the Gemini Developer API
//   npm run check:large-files-explorer -- vertex    # only Vertex AI
//   npm run check:large-files-explorer -- gemini    # only the Gemini Developer API
//
// The chat's model is CHECK_MODEL (default gemini-3.1-flash-lite) and the explorer is
// CHECK_EXPLORER (default gemini-3.5-flash-lite). Vertex region: CHECK_REGION (default global).
// CHECK_THINKING=none leaves the thinking level out. CHECK_ONLY=chart runs only the questions
// whose title holds that text. LARGE_FILES_PAGE_PLACEMENT is taken from your settings: set it to
// "beside" when one of the two models is Gemini 2.5.
//
// Each provider answers four questions: a count from a log that is searched, a question that needs
// no tool, a whole-file read, and a chart on a page of a PDF. The run fails when a request goes to
// the wrong model, when the answering model is given tools or a thought signature, or when a chat
// ends in an error.
//
// About 20 small, billable requests per provider. Credentials are never printed.
// Lines marked "·" report what the models did or said and never fail the run: a cheap model can
// find the right lines and still miscount them.

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { config } from "dotenv";

// The settings come from .env here, or from the main checkout when this runs in a git worktree.
for (const candidate of [path.resolve(".env"), path.resolve("..", "..", "..", ".env")]) {
  if (existsSync(candidate)) {
    config({ path: candidate, quiet: true });
    break;
  }
}
const MODEL = process.env.CHECK_MODEL ?? "gemini-3.1-flash-lite";
const EXPLORER = process.env.CHECK_EXPLORER ?? "gemini-3.5-flash-lite";
/** The chat's thinking level, as the chat page sends it. */
const THINKING = process.env.CHECK_THINKING ?? "low";
// The check keeps its uploads in a folder of its own, removed at the end.
const directory = await mkdtemp(path.join(tmpdir(), "gemini-prep-explorer-check-"));
process.env.LARGE_FILES_DIR = directory;
process.env.LARGE_FILES_EXPLORER_MODEL = EXPLORER;
delete process.env.LARGE_FILES_ENGINE;
delete process.env.LARGE_FILES_KEEP_PDFS;
delete process.env.LARGE_FILES_MAX_TOOL_TURNS;

// After the settings: the server reads them from the environment.
const { createApp } = await import("../server/app.js");
const { resolveGeminiChatModels, resolveProbeRegions, resolveVertexChatModels, resolveVertexProject } = await import("../server/catalog.js");
const { createServerLargeFiles } = await import("../server/documents/config.js");
const { getVertexAccessToken } = await import("../server/vertex-auth.js");

type Json = Record<string, any>;
type ProviderId = "vertex" | "gemini";
type ModelCall = { url: string; status: number; body: Json; usage: Promise<Json | undefined> };
type StreamEvent = { event: string; data: Json };

let failures = 0;
const ok = (message: string) => console.log(`  ✓ ${message}`);
const failed = (message: string) => { failures++; console.log(`  ✗ ${message}`); };
/** What the models did or said: reported, never failed. */
const info = (message: string) => console.log(`  · ${message}`);
const count = (value: number) => value.toLocaleString("en-US");
const oneLine = (text: string, most = 220) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > most ? `${flat.slice(0, most)}…` : flat;
};

/** A service log: a deadlock on every 250th line, and one fatal error with a warning eleven lines before it. */
function serviceLog(lines: number): string {
  const fatal = Math.floor(lines * 0.7);
  return Array.from({ length: lines }, (_, index) => {
    const n = index + 1;
    const clock = `2026-05-01 ${String(10 + Math.floor(n / 3600)).padStart(2, "0")}:${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
    if (n === fatal - 11) return `${clock} WARN payment-gateway: certificate for pay.internal expires in 0 days`;
    if (n === fatal) return `${clock} FATAL payment-gateway: certificate expired for host pay.internal (code PX-7741), shutting down`;
    if (n % 250 === 0) return `${clock} ERROR db: deadlock detected on table orders (tx ${n})`;
    return `${clock} INFO api: request ${n} ok in ${20 + (n * 7) % 90}ms`;
  }).join("\n");
}

/** A four-page report. Page 2 holds a bar chart drawn as shapes: South is the tallest bar, and the text does not say so. */
async function reportPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  for (let number = 1; number <= 4; number++) {
    const page = document.addPage([595, 842]);
    if (number === 2) {
      page.drawText("Figure 1: Sales by region", { x: 60, y: 760, size: 18, font: bold });
      page.drawText("The chart below compares the four regions of the company.", { x: 60, y: 720, size: 11, font });
      const bars: Array<[string, number, [number, number, number]]> = [["North", 150, [0.15, 0.4, 0.8]], ["South", 260, [0.85, 0.3, 0.2]], ["East", 110, [0.2, 0.65, 0.3]], ["West", 200, [0.9, 0.7, 0.1]]];
      bars.forEach(([name, height, [r, g, b]], index) => {
        page.drawRectangle({ x: 110 + index * 100, y: 380, width: 60, height, color: rgb(r, g, b) });
        page.drawText(name, { x: 118 + index * 100, y: 360, size: 12, font });
      });
      page.drawLine({ start: { x: 90, y: 380 }, end: { x: 520, y: 380 }, thickness: 1.5, color: rgb(0, 0, 0) });
    } else {
      page.drawText(`Section ${number}`, { x: 60, y: 760, size: 18, font: bold });
      page.drawText(`These are the notes of section ${number} of the report. They hold text only.`, { x: 60, y: 720, size: 11, font });
    }
  }
  return document.save();
}

/** A fetch that keeps what the app sent to which model, and what came back. */
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
    calls.push({ url: String(input), status: response.status, body: JSON.parse(String(init?.body ?? "{}")) as Json, usage });
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

async function upload(name: string, mimeType: string, bytes: Uint8Array): Promise<Json | undefined> {
  const app = await serve(fetch);
  try {
    const response = await fetch(`${app.base}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-File-Name": encodeURIComponent(name), "X-File-Type": mimeType },
      body: Buffer.from(bytes),
    });
    const uploaded = (await response.json()) as Json;
    if (response.status !== 201) {
      failed(`the upload of ${name} was refused: HTTP ${response.status} ${oneLine(String(uploaded.error))}`);
      return undefined;
    }
    ok(`${name} uploaded: ${count(bytes.length)} bytes, about ${count(uploaded.estimatedTokens)} tokens of text`);
    return uploaded;
  } finally {
    await app.close();
  }
}

type Scenario = {
  title: string;
  file: { id: string; name: string; mimeType: string };
  question: string;
  expect: Array<[string, RegExp]>;
  /** Settings for this question. The budget is read when the library is created. */
  settings?: Record<string, string>;
  /** The tool the question is about. Whether the explorer used it is reported, not judged. */
  tool?: string;
};

/** The model a request went to: the name between "/models/" and the method. */
const modelOf = (url: string) => /\/models\/([^/:]+):/.exec(url)?.[1] ?? "?";

async function runScenario(provider: ProviderId, region: string | undefined, scenario: Scenario) {
  console.log(`\n  ${scenario.title}`);
  const check = (passed: boolean, message: string, detail = "") => passed ? ok(message) : failed(`${message}${detail ? ` — ${detail}` : ""}`);
  const settings = { LARGE_FILES_INLINE_TOKENS: "1000", ...scenario.settings };
  for (const [key, value] of Object.entries(settings)) process.env[key] = value;
  const record = recorder();
  const app = await serve(record.fetch);
  let events: StreamEvent[] = [];
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
        messages: [{ role: "user", content: scenario.question, files: [{ kind: "document", name: scenario.file.name, mimeType: scenario.file.mimeType, documentId: scenario.file.id }] }],
      }),
    });
    const text = await response.text();
    if (response.status !== 200) {
      failed(`the chat was refused: HTTP ${response.status} ${oneLine(text)}`);
      return;
    }
    events = parseEvents(text);
  } finally {
    await app.close();
    for (const key of Object.keys(settings)) delete process.env[key];
  }

  const error = events.find((event) => event.event === "error");
  const statuses = record.calls.map((call) => call.status);
  if (error) {
    failed(`the chat ended with an error after ${record.calls.length} model requests (HTTP ${statuses.join(", ")}): ${oneLine(String(error.data.message), 400)}`);
    return;
  }
  check(events.at(-1)?.event === "done" && statuses.every((code) => code === 200), `the chat finished: ${record.calls.length} model requests, HTTP ${[...new Set(statuses)].join(", ")}`);

  // Which model got which request. A part of a whole-file read has a system instruction of its own kind.
  const partRead = (call: ModelCall) => call.body.systemInstruction?.role === "system";
  const exploring = record.calls.filter((call) => call.body.tools || partRead(call));
  const answering = record.calls.filter((call) => !call.body.tools && !partRead(call));
  const strayed = exploring.filter((call) => modelOf(call.url) !== EXPLORER);
  check(exploring.length > 0 && strayed.length === 0,
    `the explorer (${EXPLORER}) got every request with tools${exploring.some(partRead) ? " and every part read" : ""}: ${exploring.length}`,
    exploring.length === 0 ? "no request declared tools" : `${strayed.length} went to ${[...new Set(strayed.map((call) => modelOf(call.url)))].join(", ")}`);
  const last = record.calls.at(-1);
  const closing = (last?.body.contents?.at(-1)?.parts ?? []).map((part: Json) => part.text ?? "").join("");
  check(answering.length === 1 && answering[0] === last && modelOf(last.url) === MODEL && last.url.includes(":streamGenerateContent"),
    `the chat's model (${MODEL}) got one request, the last: streamed, without tools`,
    `${answering.length} requests without tools, to ${answering.map((call) => modelOf(call.url)).join(", ") || "no model"}`);
  check(!JSON.stringify(last?.body ?? {}).includes("thoughtSignature") && last?.body.contents?.at(-1)?.role === "user" && closing.length > 0,
    "that request holds no thought signature of the explorer, and ends with a message that asks for the answer",
    `closing message: "${oneLine(closing, 80)}"`);

  const steps = events.filter((event) => event.event === "step").map((event) => String(event.data.text));
  info(`steps: ${steps.length ? steps.map((step) => `"${oneLine(step, 90)}"`).join(", ") : "none: the explorer called no tool"}`);
  if (scenario.tool) {
    const used = (last?.body.contents ?? []).flatMap((content: Json) => content.parts as Json[]).some((part: Json) => part.functionCall?.name === scenario.tool);
    info(used ? `the explorer used ${scenario.tool}` : `the explorer did not use ${scenario.tool}, so this run did not check it`);
  }
  const explorerReply = exploring.filter((call) => !partRead(call)).length;
  const usages = await Promise.all(record.calls.map((call) => call.usage));
  info(`input tokens per request: ${usages.map((usage) => count(Number(usage?.promptTokenCount ?? 0))).join(", ")} (${explorerReply} of the explorer's own, ${exploring.length - explorerReply} part reads, 1 answer)`);
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
  console.log(`\n${vertex ? "Vertex AI" : "Gemini Developer API"} · explorer ${EXPLORER} → answers ${MODEL}${region ? ` · ${region}` : ""}`);
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
  // The chat's model joins the chat catalog for this run only. The explorer is not picked in the chat, so it need not be in it.
  const models = (vertex ? resolveVertexChatModels() : resolveGeminiChatModels()).map((option) => option.id);
  if (!models.includes(MODEL)) process.env[vertex ? "VERTEX_CHAT_MODELS" : "GEMINI_CHAT_MODELS"] = [...models, MODEL].join(",");

  const encoder = new TextEncoder();
  const log = await upload("app.log", "text/plain", encoder.encode(serviceLog(6_000)));
  const small = await upload("small.log", "text/plain", encoder.encode(serviceLog(1_500)));
  const report = await upload("report.pdf", "application/pdf", await reportPdf());
  if (!log || !small || !report) return;
  const file = (uploaded: Json, name: string, mimeType: string) => ({ id: String(uploaded.id), name, mimeType });

  const scenarios: Scenario[] = [
    {
      title: "A count from a log that is searched",
      file: file(log, "app.log", "text/plain"),
      question: "How many deadlocks are there in app.log, and on which line is the first one?",
      expect: [["24 deadlocks", /\b24\b/], ["the first is on line 250", /\b250\b/]],
      tool: "search_document",
    },
    {
      title: "A question that needs no tool",
      file: file(log, "app.log", "text/plain"),
      question: "Before I ask anything: what is the name of the file I attached, and how many lines does it have?",
      expect: [["the name, app.log", /app\.log/], ["6,000 lines", /6,?000/]],
    },
    {
      title: "A whole-file read in parts",
      file: file(small, "small.log", "text/plain"),
      question: "Use analyze_whole_document to read all of small.log, and tell me every kind of ERROR, WARN and FATAL message in it with how many times each occurs.",
      expect: [["the deadlocks", /deadlock/i], ["the expired certificate", /certificate|PX-7741/i]],
      settings: { LARGE_FILES_MAP_CHUNK_TOKENS: "20000" },
      tool: "analyze_whole_document",
    },
    {
      title: "A chart on a page of a PDF",
      file: file(report, "report.pdf", "application/pdf"),
      question: "Which region has the tallest bar in Figure 1 of the report? Answer with the name of the region.",
      expect: [["the tallest bar is South", /\bsouth\b/i]],
      // The text of this PDF fits, so it is sent whole and the only tool is a look at the pages.
      settings: { LARGE_FILES_INLINE_TOKENS: "200000" },
      tool: "view_pages",
    },
  ];
  const only = process.env.CHECK_ONLY?.toLowerCase();
  for (const scenario of scenarios) {
    if (!only || scenario.title.toLowerCase().includes(only)) await runScenario(provider, region, scenario);
  }
}

try {
  const only = process.argv[2];
  if (only && only !== "vertex" && only !== "gemini") throw new Error(`Unknown provider "${only}": use vertex or gemini.`);
  if (MODEL === EXPLORER) throw new Error(`CHECK_MODEL and CHECK_EXPLORER are both ${MODEL}: an explorer that is the chat's own model is no explorer.`);
  const version = (JSON.parse(await readFile(path.resolve("node_modules", "llm-large-files", "package.json"), "utf8")) as { version: string }).version;
  console.log(`An explorer model through the app's own routes · llm-large-files ${version}`);
  for (const provider of ["vertex", "gemini"] as const) {
    if (!only || only === provider) await runProvider(provider);
  }
  console.log(failures ? `\n${failures} failed.` : "\nAll checks passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
  process.exitCode = failures ? 1 : 0;
}
