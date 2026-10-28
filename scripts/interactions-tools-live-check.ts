// Live check of the generateContent → Interactions migration guide
// (docs/guides/interactions-migration-pitfalls.en.md): tool mapping, inheritance, streaming and files.
//
//   npm run check:interactions-tools            # every configured provider
//   npm run check:interactions-tools -- gemini  # only the Gemini Developer API (v1)
//   npm run check:interactions-tools -- vertex  # only Vertex AI (v1beta1, global)
//
// Calls Google directly, because the app's chat does not send custom function tools.
// About 50 small, billable requests per provider with low thinking. Credentials are never printed.
// Lines marked "·" report model-dependent behavior and never fail the run.

import "dotenv/config";
import { deflateSync } from "node:zlib";
import { resolveVertexProject } from "../server/catalog.js";
import { getVertexAccessToken } from "../server/vertex-auth.js";

type Json = Record<string, any>;
type Provider = { name: string; vertex: boolean; interactions: string; generateContent: string; headers: Record<string, string> };
type Reply = { status: number; body: Json };

const MODEL = process.env.CHECK_MODEL ?? "gemini-3.8-flash";
let failures = 0;
const ok = (message: string) => console.log(`  ✓ ${message}`);
const fail = (message: string) => { failures++; console.log(`  ✗ ${message}`); };
/** Model-dependent behavior: reported, never failed. */
const info = (message: string) => console.log(`  · ${message}`);
const section = (title: string) => console.log(`\n${title}`);
const check = (passed: boolean, message: string, detail = "") => passed ? ok(message) : fail(`${message}${detail ? ` — ${detail}` : ""}`);

const fn = (name: string, description: string) => ({
  type: "function", name, description,
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
});
const WEATHER = fn("get_weather", "Current weather for a city.");
const TIME = fn("get_time", "Current local time in a city.");
const LOW = { thinking_level: "low" };
const SPANISH = "Whenever the user asks for a number, answer with the number spelled out in Spanish, and nothing else.";

async function post(url: string, provider: Provider, body: Json): Promise<Reply> {
  const response = await fetch(url, { method: "POST", headers: provider.headers, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json };
}
const create = (p: Provider, body: Json) => post(p.interactions, p, { model: MODEL, ...body });
const steps = (reply: Reply): Json[] => Array.isArray(reply.body.steps) ? reply.body.steps : [];
const calls = (reply: Reply) => steps(reply).filter((step) => step.type === "function_call");
const answer = (reply: Reply) => steps(reply).filter((step) => step.type === "model_output")
  .flatMap((step) => step.content ?? []).map((part: Json) => part.text ?? "").join("").trim();
const errorOf = (reply: Reply) => String(reply.body.error?.message ?? JSON.stringify(reply.body)).slice(0, 160);
const result = (call: Json, value: unknown) => ({ type: "function_result", call_id: call.id, name: call.name, result: value });
const user = (...content: Json[]) => [{ type: "user_input", content }];

/** A one-page PDF whose only text is `text` (Helvetica, no compression). */
function pdf(text: string): Buffer {
  const stream = `BT /F1 18 Tf 30 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  return Buffer.from(`${out}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`, "latin1");
}

/** A solid-color 64×64 PNG. */
function png([r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: 64 }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array(64).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

/** Streams one interaction and collects the event types and the function call it builds. */
async function stream(p: Provider, body: Json) {
  const response = await fetch(p.interactions, { method: "POST", headers: p.headers, body: JSON.stringify({ model: MODEL, stream: true, ...body }) });
  if (!response.ok || !response.body) return { status: response.status, events: [] as Json[], call: {} as Json };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Json[] = [];
  const call: Json = { arguments: "" };
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const data = buffer.slice(0, end).split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      buffer = buffer.slice(end + 2);
      if (!data || data === "[DONE]") continue;
      const event = JSON.parse(data) as Json;
      events.push(event);
      if (event.event_type === "step.start" && event.step?.type === "function_call") Object.assign(call, { id: event.step.id, name: event.step.name, startArguments: event.step.arguments });
      if (event.event_type === "step.delta" && event.delta?.type === "arguments_delta") call.arguments += event.delta.arguments ?? "";
    }
  }
  return { status: response.status, events, call };
}

async function checkMapping(p: Provider) {
  const first = await create(p, { input: "What's the weather in Paris? Use the tool.", tools: [WEATHER], generation_config: LOW });
  const call = calls(first)[0];
  check(first.status === 200 && first.body.status === "requires_action", "A pending function call ends the interaction with status requires_action", `HTTP ${first.status}, status ${first.body.status}`);
  check(Boolean(call?.id && call.name === "get_weather" && typeof call.arguments === "object"), "The call is a function_call step with id, name and an arguments object", JSON.stringify(call ?? null));
  if (!call) return;
  const second = await create(p, { previous_interaction_id: first.body.id, tools: [WEATHER], generation_config: LOW, input: [result(call, [{ type: "text", text: '{"tempC":21}' }])] });
  check(second.status === 200 && second.body.status === "completed" && /21/.test(answer(second)), "function_result with call_id and previous_interaction_id completes the turn", errorOf(second));
  const object = await create(p, { previous_interaction_id: first.body.id, tools: [WEATHER], generation_config: LOW, input: [result(call, { tempC: 21 })] });
  check(object.status === 200 && /21/.test(answer(object)), "result also accepts an object", errorOf(object));
  const text = await create(p, { previous_interaction_id: first.body.id, tools: [WEATHER], generation_config: LOW, input: [result(call, '{"tempC":21}')] });
  const reachedModel = /21/.test(answer(text));
  if (p.vertex) check(text.status === 200 && !reachedModel, "A plain-string result is accepted but the model never sees it (Vertex)", `"${answer(text).slice(0, 80)}"`);
  else check(text.status === 200 && reachedModel, "A plain-string result reaches the model (Developer API)", `"${answer(text).slice(0, 80)}"`);
  const wrongId = await create(p, { previous_interaction_id: first.body.id, tools: [WEATHER], generation_config: LOW, input: [{ ...result(call, { tempC: 21 }), call_id: "call_000" }] });
  check(wrongId.status === 200, "A wrong call_id is accepted silently (no validation, so mistakes go unnoticed)", `HTTP ${wrongId.status}`);
}

async function checkToolChoice(p: Provider) {
  const any = await create(p, { input: "Say hello in one word.", tools: [WEATHER], generation_config: { ...LOW, tool_choice: "any" } });
  check(calls(any).length > 0, 'generation_config.tool_choice "any" forces a call even for a trivial prompt', `status ${any.body.status}`);
  // With tools attached, "none" sometimes makes the model try a call anyway and the request fails.
  const outcomes: string[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const none = await create(p, { input: "What's the weather in Paris? Use the tool.", tools: [WEATHER], generation_config: { ...LOW, tool_choice: "none" } });
    outcomes.push(none.status === 200 ? (calls(none).length ? "CALL" : "answer") : String(none.body.error?.code ?? none.status));
  }
  check(!outcomes.includes("CALL") && outcomes.every((outcome) => outcome === "answer" || outcome === "malformed_tool_call"),
    'tool_choice "none" never returns a call', outcomes.join(", "));
  info(`tool_choice "none" when the prompt asks for the tool: ${outcomes.join(", ")}`);
  const allowed = await create(p, { input: "What's the weather and the time in Paris?", tools: [WEATHER, TIME], generation_config: { ...LOW, tool_choice: { allowed_tools: { mode: "any", tools: ["get_time"] } } } });
  check(calls(allowed).length > 0 && calls(allowed).every((c) => c.name === "get_time"), "allowed_tools limits calls to the named functions", JSON.stringify(calls(allowed).map((c) => c.name)));
}

async function checkParallel(p: Provider) {
  const first = await create(p, { input: "What's the weather in Paris and in Rome? Call the tool once for each city.", tools: [WEATHER], generation_config: LOW });
  const pending = calls(first);
  check(pending.length === 2, "Two cities give two function_call steps in one turn", `${pending.length} call(s)`);
  if (pending.length !== 2) return;
  const all = await create(p, { previous_interaction_id: first.body.id, tools: [WEATHER], generation_config: LOW, input: pending.map((c, i) => result(c, { tempC: 20 + i })) });
  check(all.body.status === "completed", "All results in one request complete the turn", `status ${all.body.status}`);
  const partial = await create(p, { previous_interaction_id: first.body.id, tools: [WEATHER], generation_config: LOW, input: [result(pending[0]!, { tempC: 20 })] });
  info(`Only one of two results returned → ${partial.body.status === "requires_action" ? "the model called the tool again (extra round)" : `answered without it: "${answer(partial).replace(/\s+/g, " ").slice(0, 90)}"`}`);
}

async function checkInheritance(p: Provider) {
  const first = await create(p, { input: "What's the weather in Paris? Use the tool.", tools: [WEATHER, TIME], generation_config: LOW });
  const call = calls(first)[0];
  if (!call) { fail("Inheritance setup — no function call"); return; }
  const done = await create(p, { previous_interaction_id: first.body.id, tools: [WEATHER, TIME], generation_config: LOW, input: [result(call, { tempC: 21 })] });
  const ask = "What time is it in Tokyo right now? Use a tool if you have one.";
  const without = await create(p, { previous_interaction_id: done.body.id, input: ask, generation_config: LOW });
  const withTools = await create(p, { previous_interaction_id: done.body.id, input: ask, tools: [WEATHER, TIME], generation_config: LOW });
  const detail = `without: ${JSON.stringify(calls(without).map((c) => c.name))}, with: ${JSON.stringify(calls(withTools).map((c) => c.name))}`;
  const usedWithout = calls(without).some((c) => c.name === "get_time");
  check(calls(withTools).some((c) => c.name === "get_time"), "A tool declared earlier works when tools are sent again", detail);
  if (p.vertex) check(usedWithout, "Vertex carries tools over: get_time is still callable without resending tools", detail);
  else check(!usedWithout, "Developer API drops tools: get_time is not callable without resending tools", detail);

  const sys = await create(p, { input: "Say hi.", system_instruction: SPANISH, generation_config: LOW });
  const sysWithout = await create(p, { previous_interaction_id: sys.body.id, input: "What is 2+2? Answer with just the number.", generation_config: LOW });
  const sysWith = await create(p, { previous_interaction_id: sys.body.id, input: "What is 2+2? Answer with just the number.", system_instruction: SPANISH, generation_config: LOW });
  check(/4/.test(answer(sysWithout)) && /cuatro/i.test(answer(sysWith)), "system_instruction is not inherited", `without: "${answer(sysWithout)}", with: "${answer(sysWith)}"`);

  const stop = await create(p, { input: "Count from 1 to 6, separated by commas.", generation_config: { ...LOW, stop_sequences: ["4"] } });
  const next = await create(p, { previous_interaction_id: stop.body.id, input: "Count from 1 to 6 again, separated by commas.", generation_config: LOW });
  check(!/4/.test(answer(stop)) && /6/.test(answer(next)), "generation_config (stop_sequences) is not inherited", `first: "${answer(stop)}", next: "${answer(next)}"`);
}

async function checkDoubleContext(p: Provider) {
  const question = `Here is a long note: ${"alpha beta gamma delta ".repeat(60)} What's the weather in Paris? Use the tool.`;
  const first = await create(p, { input: question, tools: [WEATHER], generation_config: LOW });
  const call = calls(first)[0];
  if (!call) { fail("Double-context setup — no function call"); return; }
  const reply = result(call, { tempC: 21 });
  const lean = await create(p, { previous_interaction_id: first.body.id, tools: [WEATHER], generation_config: LOW, input: [reply] });
  const doubled = await create(p, { previous_interaction_id: first.body.id, tools: [WEATHER], generation_config: LOW,
    input: [{ type: "user_input", content: [{ type: "text", text: question }] }, ...steps(first), reply] });
  // The Developer API reports the full context as initial_input_tokens on chained turns; Vertex as total_input_tokens.
  const context = (reply: Reply) => Number(reply.body.usage?.initial_input_tokens ?? reply.body.usage?.total_input_tokens);
  const historyTokens = Number(first.body.usage?.total_input_tokens);
  check(context(doubled) - context(lean) >= 0.8 * historyTokens,
    "Resending history together with previous_interaction_id adds the whole history again", `${context(lean)} → ${context(doubled)} (history ${historyTokens})`);
  const chained = await create(p, { previous_interaction_id: lean.body.id, input: "Reply OK.", generation_config: LOW });
  const usage = chained.body.usage ?? {};
  if (p.vertex) check(usage.initial_input_tokens === undefined && usage.total_input_tokens > 100, "Vertex: total_input_tokens on a chained turn includes the stored history", JSON.stringify(usage));
  else check(usage.total_input_tokens < 20 && usage.initial_input_tokens > 100, "Developer API, text-only chain: total_input_tokens counts only the new input; initial_input_tokens has the full context", JSON.stringify(usage));
}

async function checkStatelessAndOldShapes(p: Provider) {
  const question = "What's the weather in Paris? Use the tool.";
  const first = await create(p, { input: question, tools: [WEATHER], store: false, generation_config: LOW });
  const call = calls(first)[0];
  if (!call) { fail("store:false setup — no function call"); return; }
  const user = { type: "user_input", content: [{ type: "text", text: question }] };
  const full = await create(p, { store: false, tools: [WEATHER], generation_config: LOW, input: [user, ...steps(first), result(call, { tempC: 21 })] });
  check(full.status === 200 && full.body.status === "completed", "store:false works when every returned step (thought included) is sent back unchanged", errorOf(full));
  const dropped = await create(p, { store: false, tools: [WEATHER], generation_config: LOW, input: [user, ...steps(first).filter((s) => s.type !== "thought"), result(call, { tempC: 21 })] });
  check(dropped.status === 400, "store:false without the thought step is rejected with a generic 400", `HTTP ${dropped.status}: ${errorOf(dropped)}`);

  const oldShapes: Array<[string, Json]> = [
    ["{ googleSearch: {} }", { input: "Hi", tools: [{ googleSearch: {} }] }],
    ["toolConfig", { input: "Hi", tools: [WEATHER], toolConfig: { functionCallingConfig: { mode: "ANY" } } }],
    ["top-level tool_choice", { input: "Hi", tools: [WEATHER], tool_choice: "any" }],
    ["a function_response input", { input: [{ type: "function_response", name: "get_weather", response: { tempC: 21 } }] }],
  ];
  for (const [label, body] of oldShapes) {
    const reply = await create(p, { ...body, generation_config: LOW });
    check(reply.status === 400, `Old shape rejected: ${label}`, `HTTP ${reply.status}: ${errorOf(reply)}`);
  }
  const search = await create(p, { input: "Who won the most recent Nobel Prize in Physics? One sentence.", tools: [{ type: "google_search" }], generation_config: LOW });
  check(steps(search).some((s) => s.type === "google_search_call") && search.body.status === "completed", "{ type: \"google_search\" } runs server-side and completes without requires_action", `status ${search.body.status}`);
}

async function checkJsonOutput(p: Provider) {
  const schema = { type: "object", properties: { sum: { type: "integer" } }, required: ["sum"] };
  const json = await create(p, { input: "What is 2 + 3? Answer in JSON.", response_format: { type: "text", mime_type: "application/json", schema }, generation_config: LOW });
  check(json.status === 200 && /"sum"\s*:\s*5/.test(answer(json)), "JSON output: top-level response_format { type, mime_type, schema }", errorOf(json));
  const upper = await create(p, { input: "What's the weather in Paris? Use the tool.", generation_config: LOW,
    tools: [{ ...WEATHER, parameters: { type: "OBJECT", properties: { city: { type: "STRING" } }, required: ["city"] } }] });
  check(calls(upper).length > 0, "Uppercase schema types (OBJECT/STRING) are still accepted", errorOf(upper));
  if (p.vertex) return;
  const beta = await create(p, { input: "What is 2 + 3? Answer in JSON.", response_mime_type: "application/json", response_format: schema, generation_config: LOW });
  check(beta.status === 400 && /only available in v1beta/.test(errorOf(beta)), "Old shape rejected on v1: response_mime_type", `HTTP ${beta.status}: ${errorOf(beta)}`);
}

async function checkStreaming(p: Provider) {
  const { status, events, call } = await stream(p, { input: "What's the weather in Paris? Use the tool.", tools: [WEATHER], generation_config: LOW });
  if (status !== 200) { fail(`Streaming — HTTP ${status}`); return; }
  const terminal = events.find((event) => event.event_type === "interaction.completed");
  check(Boolean(call.id && call.name) && typeof call.arguments === "string" && call.arguments.includes("Paris"),
    "Streamed call: step.start gives id and name, step.delta arguments_delta gives the arguments as a JSON string", JSON.stringify(call));
  check(terminal?.interaction?.status === "requires_action", 'The terminal event is interaction.completed with status "requires_action"', String(terminal?.interaction?.status));
}

async function checkGenerateContentBaseline(p: Provider) {
  const user = { role: "user", parts: [{ text: "What's the weather in Paris? Use the tool." }] };
  const config = { tools: [{ functionDeclarations: [{ name: WEATHER.name, description: WEATHER.description, parameters: WEATHER.parameters }] }], generationConfig: { thinkingConfig: { thinkingLevel: "low" } } };
  const first = await post(p.generateContent, p, { contents: [user], ...config });
  const content = first.body.candidates?.[0]?.content as Json | undefined;
  const part = (content?.parts ?? []).find((candidate: Json) => candidate.functionCall) as Json | undefined;
  check(Boolean(part?.functionCall?.name && part.functionCall.args && part.thoughtSignature), "generateContent: functionCall { name, args, id } with a thoughtSignature on the part", JSON.stringify(part?.functionCall ?? errorOf(first)));
  if (!part || !content) return;
  const response = { role: "user", parts: [{ functionResponse: { name: part.functionCall.name, id: part.functionCall.id, response: { tempC: 21 } } }] };
  const full = await post(p.generateContent, p, { contents: [user, content, response], ...config });
  check(full.status === 200, "generateContent: full history plus functionResponse completes the turn", errorOf(full));
  const stripped = { role: "model", parts: content.parts.map(({ thoughtSignature: _signature, ...rest }: Json) => rest) };
  const missing = await post(p.generateContent, p, { contents: [user, stripped, response], ...config });
  check(missing.status === 400 && /thought_signature/i.test(errorOf(missing)), "generateContent: dropping thoughtSignature is rejected with a clear 400", `HTTP ${missing.status}`);
}

async function checkInlineFiles(p: Provider) {
  const doc = { type: "document", mime_type: "application/pdf", data: pdf("The secret code is 4417.").toString("base64") };
  const image = { type: "image", mime_type: "image/png", data: png([220, 20, 20]).toString("base64") };
  const ask = { type: "text", text: "Here is a document and an image. Reply OK only." };

  const flat = await create(p, { input: [image, ask], generation_config: LOW });
  if (p.vertex) check(flat.status === 200, "Vertex accepts a flat input array of content items", errorOf(flat));
  else check(flat.status === 400 && /available in v1beta/.test(errorOf(flat)), "Developer API v1 rejects a flat input array; files need a user_input step", `HTTP ${flat.status}: ${errorOf(flat)}`);

  const first = await create(p, { input: user(doc, image, ask), generation_config: LOW });
  const fileTokens = (reply: Reply) => Number((reply.body.usage?.input_tokens_by_modality ?? []).find((m: Json) => m.modality === "image")?.tokens);
  const second = await create(p, { previous_interaction_id: first.body.id, input: "What is the secret code in the document, and what color is the image? One short line.", generation_config: LOW });
  check(/4417/.test(answer(second)) && /red/i.test(answer(second)), "Files sent inline once are still readable on a chained turn", `"${answer(second)}"`);
  check(fileTokens(second) > 0 && fileTokens(second) === fileTokens(first), "The files are counted again on every chained turn", `image-modality tokens: ${fileTokens(first)} → ${fileTokens(second)}`);
  const fresh = await create(p, { input: "What is the secret code in the document? If you have no document, reply NONE.", generation_config: LOW });
  check(!/4417/.test(answer(fresh)), "A new interaction does not see them", `"${answer(fresh)}"`);
  if (!p.vertex) info(`Developer API total_input_tokens on a chained turn with a file: ${second.body.usage?.total_input_tokens} (initial_input_tokens ${second.body.usage?.initial_input_tokens})`);

  const stored = await fetch(`${p.interactions}/${encodeURIComponent(first.body.id)}`, { headers: p.headers });
  check(stored.status === 200 && (await stored.text()).includes(doc.data.slice(0, 60)), "GET on the stored interaction returns the file bytes", `HTTP ${stored.status}`);
  const removed = await fetch(`${p.interactions}/${encodeURIComponent(first.body.id)}`, { method: "DELETE", headers: p.headers });
  const afterDelete = await create(p, { previous_interaction_id: first.body.id, input: "What color was the image?", generation_config: LOW });
  check(removed.status === 200 && afterDelete.status === 404, "After DELETE, continuing the chain fails with 404", `DELETE ${removed.status}, continue ${afterDelete.status}`);

  const dataUrl = await create(p, { input: user({ ...image, data: `data:image/png;base64,${image.data}` }, ask), generation_config: LOW });
  check(dataUrl.status === 400 && /corrupt base64/.test(errorOf(dataUrl)), "A data: URL prefix in data is rejected as corrupt base64", `HTTP ${dataUrl.status}`);
  const noMime = await create(p, { input: user({ type: "image", data: image.data }, ask), generation_config: LOW });
  check(p.vertex ? noMime.status === 400 : noMime.status === 200, `Missing mime_type: ${p.vertex ? "rejected on Vertex" : "guessed on the Developer API"}`, `HTTP ${noMime.status}: ${errorOf(noMime)}`);
  const asDocument = (mime: string, text: string) => create(p, { input: user({ type: "document", mime_type: mime, data: Buffer.from(text).toString("base64") }, { type: "text", text: "What is the secret code? Number only." }), generation_config: LOW });
  const markdown = await asDocument("text/markdown", "# Note\n\nThe secret code is **5522**.");
  check(/5522/.test(answer(markdown)), "text/markdown documents are read as text", errorOf(markdown));
  const json = await asDocument("application/json", '{"secret_code": 5524}');
  check(p.vertex ? json.status === 400 : /5524/.test(answer(json)), `application/json documents: ${p.vertex ? "rejected on Vertex" : "read on the Developer API"}`, `HTTP ${json.status}: ${errorOf(json)}`);
  const docx = await asDocument("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK not a real docx");
  check(docx.status === 400, "DOCX documents are rejected", `HTTP ${docx.status}`);

  if (p.vertex) return;
  // Files API reference: the stored chain keeps only the link, so a deleted (or expired) file breaks it.
  const bytes = pdf("The secret code is 4417.");
  const start = await fetch("https://generativelanguage.googleapis.com/upload/v1beta/files", { method: "POST", headers: {
    "x-goog-api-key": p.headers["x-goog-api-key"]!, "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": String(bytes.length), "X-Goog-Upload-Header-Content-Type": "application/pdf", "Content-Type": "application/json",
  }, body: JSON.stringify({ file: { display_name: "interactions-tools-live-check" } }) });
  const uploaded = await fetch(start.headers.get("x-goog-upload-url")!, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: new Uint8Array(bytes) });
  const file = ((await uploaded.json()) as Json).file as Json;
  const linked = await create(p, { input: user({ type: "document", uri: file.uri, mime_type: "application/pdf" }, ask), generation_config: LOW });
  await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, { method: "DELETE", headers: { "x-goog-api-key": p.headers["x-goog-api-key"]! } });
  const broken = await create(p, { previous_interaction_id: linked.body.id, input: "Reply OK.", generation_config: LOW });
  check(linked.status === 200 && broken.status === 403, "A chain that references a deleted Files API upload fails with 403 on every later turn", `first ${linked.status}, after delete ${broken.status}: ${errorOf(broken)}`);
}

async function runProvider(p: Provider) {
  section(`${p.name} — ${MODEL}`);
  for (const step of [checkGenerateContentBaseline, checkMapping, checkToolChoice, checkParallel, checkInheritance, checkDoubleContext, checkStatelessAndOldShapes, checkJsonOutput, checkStreaming, checkInlineFiles]) {
    try { await step(p); } catch (error) { fail(`${step.name} — ${error instanceof Error ? error.message : String(error)}`); }
  }
}

async function main() {
  const only = process.argv[2];
  if (only !== "vertex") {
    const key = process.env.GEMINI_API_KEY;
    if (!key) fail("GEMINI_API_KEY is not configured");
    else await runProvider({
      name: "Gemini Developer API (v1)", vertex: false,
      interactions: "https://generativelanguage.googleapis.com/v1/interactions",
      generateContent: `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    });
  }
  if (only !== "gemini") {
    const { project } = resolveVertexProject(null);
    if (!project) fail("No Google Cloud project is configured (GCP_PROJECT)");
    else {
      const path = `projects/${encodeURIComponent(project)}/locations/global`;
      await runProvider({
        name: "Vertex AI (v1beta1, global)", vertex: true,
        interactions: `https://aiplatform.googleapis.com/v1beta1/${path}/interactions`,
        generateContent: `https://aiplatform.googleapis.com/v1/${path}/publishers/google/models/${MODEL}:generateContent`,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getVertexAccessToken()}` },
      });
    }
  }
}

main()
  .catch((error) => fail(error instanceof Error ? error.message : String(error)))
  .finally(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
    process.exitCode = failures ? 1 : 0;
  });
