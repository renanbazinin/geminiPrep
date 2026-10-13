// Live check of every chat request path with the Gemini 4 toggle on.
//
//   npm run check:gemini-4            # every configured provider
//   npm run check:gemini-4 -- gemini  # only the Gemini Developer API
//   npm run check:gemini-4 -- vertex  # only Vertex AI
//
// Sends real, billable requests through this app's own /api/chat/stream, so the same validation
// and request mapping the browser uses are under test. Each call is a few words with low thinking.
// Credentials stay on the server and are never printed.

import "dotenv/config";
import type { AddressInfo } from "node:net";
import type { ChatStreamRequest, InteractionOptions } from "../shared/contracts.js";
import { DEFAULT_INTERACTIONS } from "../shared/interactions.js";
import { PRO_MODEL } from "../shared/gemini-4.js";
import { resolveVertexProject } from "../server/catalog.js";
import { createApp } from "../server/app.js";

type StreamEvent = { event: string; data: Record<string, unknown> };
type Check = {
  name: string;
  body: ChatStreamRequest;
  /** Optional follow-up that reuses the interaction ID this check returns. */
  followUp?: { name: string; content: string; expect: RegExp };
  expect?: RegExp;
  expectRejected?: RegExp;
};

let failures = 0;
const ok = (message: string) => console.log(`  ✓ ${message}`);
const fail = (message: string) => { failures++; console.log(`  ✗ ${message}`); };
const section = (title: string) => console.log(`\n${title}`);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

const interactions = (extra: Partial<InteractionOptions> = {}): InteractionOptions => ({ ...DEFAULT_INTERACTIONS, thinkingLevel: "low", ...extra });
const ask = (content: string): ChatStreamRequest["messages"] => [{ role: "user", content }];
const base = { model: PRO_MODEL.id, temperature: 1, maxOutputTokens: 8192 } as const;

function parseEvents(text: string): StreamEvent[] {
  return text.split("\n\n").filter((block) => block.startsWith("event:")).map((block) => {
    const [eventLine, ...dataLines] = block.split("\n");
    return { event: eventLine!.slice(7).trim(), data: JSON.parse(dataLines.map((line) => line.slice(6)).join("\n")) as Record<string, unknown> };
  });
}

function usageSummary(done: Record<string, unknown>): string {
  const usage = (done.usage ?? {}) as Record<string, unknown>;
  const thought = usage.total_thought_tokens ?? usage.thoughtsTokenCount;
  const total = usage.total_tokens ?? usage.totalTokenCount;
  return [total !== undefined ? `${total} tokens` : "", thought !== undefined ? `${thought} thinking` : ""].filter(Boolean).join(", ");
}

async function post(baseUrl: string, body: ChatStreamRequest) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/chat/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  const ms = Date.now() - started;
  if (!response.ok) return { status: response.status, error: (JSON.parse(text) as { error?: string }).error ?? text, ms };
  const events = parseEvents(text);
  const answer = events.filter((event) => event.event === "delta").map((event) => String(event.data.text)).join("");
  const done = events.find((event) => event.event === "done")?.data;
  const streamError = events.find((event) => event.event === "error")?.data;
  // The sanitized upstream request: Interactions names the model in the body, Generate Content in the URL.
  const providerRequest = JSON.stringify(events.find((event) => event.event === "meta")?.data.providerRequest ?? null);
  return { status: response.status, answer, done, streamError, providerRequest, ms };
}

async function run(baseUrl: string, check: Check) {
  const result = await post(baseUrl, check.body);
  if (check.expectRejected) {
    if (result.status === 400 && "error" in result && check.expectRejected.test(String(result.error))) ok(`${check.name} — rejected locally before calling Google`);
    else fail(`${check.name} — expected a local 400, got HTTP ${result.status}`);
    return;
  }
  if (!("done" in result) || !result.done) {
    const reason = "error" in result ? result.error : result.streamError?.message ?? "the stream ended without a result";
    fail(`${check.name} — ${String(reason)}`);
    return;
  }
  if (!result.providerRequest.includes(PRO_MODEL.id)) { fail(`${check.name} — the request to Google did not name ${PRO_MODEL.id}`); return; }
  const answer = result.answer.replace(/\s+/g, " ").trim();
  if (check.expect && !check.expect.test(answer)) {
    fail(`${check.name} — unexpected answer "${answer.slice(0, 80)}"`);
    return;
  }
  ok(`${check.name} — "${answer.slice(0, 60)}" (${seconds(result.ms)}${usageSummary(result.done) ? `, ${usageSummary(result.done)}` : ""})`);

  if (!check.followUp) return;
  const interactionId = result.done.interactionId;
  if (typeof interactionId !== "string") { fail(`${check.followUp.name} — the first turn returned no interaction ID`); return; }
  const next = await post(baseUrl, { ...check.body, previousInteractionId: interactionId, messages: ask(check.followUp.content) });
  const nextAnswer = ("answer" in next ? next.answer ?? "" : "").replace(/\s+/g, " ").trim();
  if ("done" in next && next.done && check.followUp.expect.test(nextAnswer)) {
    ok(`${check.followUp.name} — "${nextAnswer.slice(0, 60)}" (${seconds(next.ms)}, sent only the new turn)`);
  } else {
    fail(`${check.followUp.name} — ${"error" in next ? String(next.error) : next.streamError?.message ?? `unexpected answer "${nextAnswer.slice(0, 80)}"`}`);
  }
}

function geminiChecks(): Check[] {
  const memory = { name: "Interactions v1 · follow-up remembers the first turn", content: "What was the secret word? Reply with the word only.", expect: /argon/i };
  return [
    { name: "Interactions v1 · new conversation", body: { provider: "gemini", ...base, interactions: interactions(), messages: ask("The secret word is ARGON. Reply with OK only.") }, expect: /ok/i, followUp: memory },
    { name: "Interactions v1beta · minimal thinking and Top P (sent as low, Top P dropped)", body: { provider: "gemini", ...base, interactions: interactions({ apiVersion: "v1beta", thinkingLevel: "minimal", topP: 0.5 }), messages: ask("Reply with the number 4 only.") }, expect: /4/ },
    { name: "Interactions v1 · JSON schema output", body: { provider: "gemini", ...base, interactions: interactions({ responseFormat: "json", responseSchema: JSON.stringify({ type: "object", properties: { sum: { type: "integer" } }, required: ["sum"] }) }), messages: ask("What is 2 + 3? Answer in the requested JSON.") }, expect: /"sum"\s*:\s*5/ },
    { name: "Generate Content · streaming with automatic tool routing", body: { provider: "gemini", ...base, thinkingLevel: "low", messages: ask("Reply with the word pong only.") }, expect: /pong/i },
  ];
}

function vertexChecks(project: string): Check[] {
  const vertex = { provider: "vertex" as const, ...base };
  const memory = { name: "Interactions (global) · follow-up remembers the first turn", content: "What was the secret word? Reply with the word only.", expect: /argon/i };
  return [
    { name: "Interactions (global) · new conversation", body: { ...vertex, region: "global", interactionProject: project, interactions: interactions(), messages: ask("The secret word is ARGON. Reply with OK only.") }, expect: /ok/i, followUp: memory },
    { name: "Generate Content · global endpoint", body: { ...vertex, region: "global", thinkingLevel: "low", messages: ask("Reply with the word pong only.") }, expect: /pong/i },
    { name: "Generate Content · EU multi-region (eu)", body: { ...vertex, region: "eu", thinkingLevel: "low", messages: ask("Reply with the word pong only.") }, expect: /pong/i },
    { name: "Generate Content · US multi-region (us)", body: { ...vertex, region: "us", thinkingLevel: "low", messages: ask("Reply with the word pong only.") }, expect: /pong/i },
    { name: "Generate Content · europe-west1 (no Gemini 4 there)", body: { ...vertex, region: "europe-west1", thinkingLevel: "low", messages: ask("Reply with the word pong only.") }, expectRejected: /not served from europe-west1/ },
  ];
}

async function main() {
  const only = process.argv[2];
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`Checking ${PRO_MODEL.id} through ${baseUrl}/api/chat/stream`);
  try {
    if (only !== "vertex") {
      section("Gemini Developer API");
      if (!process.env.GEMINI_API_KEY) fail("GEMINI_API_KEY is not configured");
      else for (const check of geminiChecks()) await run(baseUrl, check);
    }
    if (only !== "gemini") {
      section("Vertex AI");
      const { project } = resolveVertexProject(null);
      if (!project) fail("No Google Cloud project is configured (GCP_PROJECT)");
      else for (const check of vertexChecks(project)) await run(baseUrl, check);
    }
  } finally {
    server.close();
  }
}

main()
  .catch((error) => fail(error instanceof Error ? error.message : String(error)))
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
    process.exitCode = failures ? 1 : 0;
  });
