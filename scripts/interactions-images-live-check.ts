// Billable live check through the real local chat adapter. No credentials or image bytes are printed.
// npx tsx scripts/interactions-images-live-check.ts [gemini|vertex] [v1|v1beta]
// Defaults: both Developer API versions and Vertex v1beta1/global; two image calls per path.
// CHECK_IMAGE_SIZE and CHECK_IMAGE_ASPECT_RATIO select one combination; no exhaustive paid sweep.
// CHECK_IMAGE_INPUT_ONLY=true checks inline PNG understanding instead of generating/editing images.
import "dotenv/config";
import { once } from "node:events";
import { deflateSync } from "node:zlib";
import { createApp } from "../server/app.js";
import { resolveVertexProject } from "../server/catalog.js";
import { DEFAULT_INTERACTIONS, parseInteractionOptions } from "../shared/interactions.js";
import { IMAGE_MODEL_ID } from "../shared/chat-tools.js";
import { parseSseJson } from "../server/chat/upstream.js";
import type { ChatStreamRequest, ChatStreamEvent } from "../shared/contracts.js";

const only = process.argv[2];
const version = process.argv[3];
if ((only && !["gemini", "vertex"].includes(only)) || (version && !["v1", "v1beta"].includes(version))) {
  throw new Error("Usage: npx tsx scripts/interactions-images-live-check.ts [gemini|vertex] [v1|v1beta]");
}
const interactions = parseInteractionOptions({
  ...DEFAULT_INTERACTIONS,
  imageSize: process.env.CHECK_IMAGE_SIZE ?? "1K",
  imageAspectRatio: process.env.CHECK_IMAGE_ASPECT_RATIO ?? "16:9",
});
const server = createApp().listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("No local test server address.");
const url = `http://127.0.0.1:${address.port}/api/chat/stream`;
let failures = 0;
let checks = 0;
const inputOnly = process.env.CHECK_IMAGE_INPUT_ONLY === "true";

function redPng(): string {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(payload));
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(64, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const row = Buffer.from([0, ...Array.from({ length: 64 }, () => [220, 20, 20]).flat()]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array(64).fill(row)))), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

async function check(request: ChatStreamRequest, label: string): Promise<string | undefined> {
  checks++;
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request), signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body) throw new Error(`Local HTTP ${response.status}`);
  let images = 0;
  let id: string | undefined;
  let completed = false;
  let text = "";
  for await (const event of parseSseJson<ChatStreamEvent["data"]>(response.body)) {
    // parseSseJson returns the SSE data object; each event has a distinct shape.
    if ("message" in event) throw new Error(`${"status" in event ? event.status : "Provider"}: ${event.message}`);
    if ("text" in event) text += event.text;
    if ("mimeType" in event && "data" in event) {
      const bytes = Buffer.from(event.data, "base64");
      if (bytes.length < 100) throw new Error("Image payload is unexpectedly small.");
      images++;
      console.log(`  image: ${event.mimeType}, ${bytes.length} bytes`);
    }
    if ("interactionStatus" in event) {
      completed = event.interactionStatus === "completed";
      id = "interactionId" in event ? event.interactionId : undefined;
    }
  }
  if (!completed || (inputOnly ? !/red/i.test(text) : !images) || !id) throw new Error(`completed=${completed}, images=${images}, stored ID=${Boolean(id)}, red recognized=${/red/i.test(text)}`);
  console.log(`PASS ${label}: ${images} image(s), ${Date.now() - started}ms`);
  return id;
}

try {
  for (const provider of ["gemini", "vertex"] as const) {
    if (only && provider !== only) continue;
    const { project } = resolveVertexProject(null);
    if (provider === "gemini" ? !process.env.GEMINI_API_KEY : !project) {
      console.log(`SKIP ${provider}: credentials/project not configured`);
      continue;
    }
    for (const apiVersion of provider === "vertex" ? ["v1"] as const : version ? [version as "v1" | "v1beta"] : ["v1", "v1beta"] as const) {
      const label = `${provider}/${provider === "vertex" ? "v1beta1/global" : apiVersion}/${interactions.imageSize}/${interactions.imageAspectRatio}`;
      const request: ChatStreamRequest = {
        provider, model: inputOnly ? "gemini-3.8-flash" : IMAGE_MODEL_ID,
        ...(!inputOnly ? { tool: "image" as const } : {}), temperature: 1, maxOutputTokens: 8192,
        interactions: { ...interactions, apiVersion, ...(inputOnly ? { thinkingLevel: "low" as const } : {}) },
        ...(provider === "vertex" ? { region: "global", interactionProject: project! } : {}),
        messages: [{ role: "user", content: inputOnly ? "What is the dominant color in this image? Answer in one word."
          : process.env.CHECK_IMAGE_PROMPT ?? "Create an original watercolor illustration of a red ceramic cup beside a yellow pear on a pale table. No text.",
          ...(inputOnly ? { files: [{ kind: "inlineData" as const, name: "red.png", mimeType: "image/png" as const, data: redPng() }] } : {}),
        }],
      };
      try {
        const id = await check(request, `${label}/${inputOnly ? "understand-inline-png" : "generate"}`);
        if (inputOnly) continue;
        await check({ ...request, previousInteractionId: id,
          messages: [{ role: "user", content: "Edit the previous image: change the red object to blue. Keep everything else the same." }],
        }, `${label}/edit`);
      } catch (error) {
        failures++;
        console.log(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log(`Finished: ${checks} call(s), ${failures} failed path(s). Stored test interactions follow Google's normal retention.`);
process.exitCode = failures || !checks ? 1 : 0;
