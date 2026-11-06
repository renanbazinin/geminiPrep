# llm-large-files (working name)

Make books, logs, and other oversized files usable by an LLM that has a **request-size limit**
(for example a 10 MB enterprise connector) and a **context window** (for example 1M tokens).

It is a small library, not an agent framework: no model SDK, no server, no UI. You give it bytes
and limits; it gives you prompt text, tool declarations, and a tool executor. Your app keeps its
own model calls, streaming, and auth.

## How it works

```
upload ─► ingest ─► store            (extract text, normalize, index lines, profile logs, outline)
                      │
chat turn ─► prepare(ids, base size)
                      ├─ fits the budget ─► full text goes into the prompt
                      └─ too large ──────► a summary card goes into the prompt
                                            + tools: search / read / overview / analyze-all
                                            + a system instruction on how to use them
```

- **Planner.** Smaller files are inlined first, until either the token budget or the request-byte
  budget is used. The rest become searchable. One rule covers both limits.
- **Cards.** A searchable file is represented by its ID, size, outline (headings with line
  numbers), the first lines, and for logs a profile: level counts, time range, and the most frequent
  error shapes (`timeout after <n>ms to <ip>`). The model often knows where to look before its first
  tool call.
- **Tools.** `search_document` (keywords ranked with BM25, exact text, or regex), `read_document`
  (line ranges), `get_document_overview`, and `analyze_whole_document` (map-reduce over the whole
  file, only when you supply a `generate` function). Results are capped in size and carry line
  numbers so answers can cite `app.log L1203`.
- **Map-reduce.** Splits on line boundaries into parts that fit both limits, reads parts in
  parallel, retries a failed part once, merges notes in rounds if they are still too large, then
  writes one answer. It refuses jobs that would need more than `maxMapChunks` calls.

## Quick start

```ts
import {
  createLargeFiles, FileDocumentStore, createGeminiGenerateText, geminiFunctionResponses,
} from "llm-large-files";

const files = createLargeFiles({
  store: new FileDocumentStore("./data/large-files"),
  budget: { contextTokens: 1_000_000, maxRequestBytes: 10_000_000 },
});

// 1. On upload
const meta = await files.ingest({ name: "app.log", mimeType: "text/plain", bytes });

// 2. On each chat turn: size the rest of the request, then plan
const prepared = await files.prepare([meta.id], { tokens: 3_000, bytes: 20_000 });
const userText = `${question}\n\n${prepared.blocks.get(meta.id)}`;
const system = [mySystemPrompt, prepared.instruction].filter(Boolean).join("\n\n");

// 3. If anything is searchable, run a tool loop
if (prepared.plan.searchable.length) {
  const tools = files.tools(prepared.plan.searchable, {
    generate: createGeminiGenerateText({ url: generateContentUrl, headers }), // enables analyze-all
    onProgress: (event) => console.log(event.message),
  });
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    tools: [{ functionDeclarations: tools.declarations }],
  };
  for (let turn = 0; turn < 12; turn++) {
    const reply = await callGemini(body);              // your HTTP call
    const parts = reply.candidates[0].content.parts;
    const calls = parts.filter((part) => part.functionCall).map((part) => part.functionCall);
    if (!calls.length) return text(parts);
    body.contents.push({ role: "model", parts });      // unchanged: keeps thought signatures
    const results = [];
    for (const call of calls) results.push({ call, result: await tools.execute(call.name, call.args ?? {}) });
    body.contents.push(geminiFunctionResponses(results));
  }
  // Out of turns: ask once more with `tools` removed. Gemini can ignore mode "NONE".
}
```

The host app in this repository has a streaming version of this loop with progress events:
[`server/chat/document-stream.ts`](../../server/chat/document-stream.ts).

## Budget

| Setting | Default | Meaning |
|---|---|---|
| `contextTokens` | 1,000,000 | Model context window |
| `maxRequestBytes` | 10,000,000 | Largest request body the connector accepts |
| `inlineTokens` | 200,000 | Most document text to include in full per request |
| `reservedTokens` | 64,000 | Kept free for the answer and tool results |
| `mapChunkTokens` | 100,000 | Part size for whole-document reads |
| `maxMapChunks` | 30 | Refuse whole-document reads needing more model calls |
| `toolResultCharacters` | 24,000 | Cap on one tool result |

Token counts are a conservative estimate (about 4 characters per token for ASCII, 1.5 for other
scripts). In a live check, a 467 KB English text was estimated at 116,840 tokens and Gemini
billed 116,842.

## Formats

Text, Markdown, logs (by extension or by sniffing timestamps and levels), JSON/JSONL, CSV/TSV,
DOCX, PPTX, and PDF. UTF-16 files (common for Windows logs) are decoded, binary files are
rejected, and lines over 2,000 characters are wrapped so every line stays addressable.

DOCX/PPTX need the optional peer `jszip`; PDF needs the optional peer `unpdf` (pinned to 1.4.0 here).
Scanned PDFs without a text layer are rejected with a message; OCR is out of scope.

## Stores

`MemoryDocumentStore` (tests, single process) and `FileDocumentStore` (one directory, survives
restarts, sweeps expired files). Implement `DocumentStore` for Redis, S3, or a database.

## Security notes

- **Scope.** Tools only accept the document IDs they were created with, so a model cannot reach
  another conversation's files by guessing IDs.
- **IDs** are random 128-bit values validated by pattern before any file-system access.
- **Regex** search rejects nested quantifiers like `(a+)+` and stops after 3 s; a single
  pathological line can still be slow, so cap line length upstream if users control patterns.
- **No authentication.** The library has no notion of users. The host must tie document IDs to
  the signed-in user (for example store the owner in the metadata and check it in the routes).
- **Retention.** Files expire after `ttlMs` (default 72 h). Choose this to match your data policy.

## Limits and next steps

- Search is lexical (BM25 over substrings), no embeddings. A `Retriever` interface for vector
  search is the natural extension point.
- Adapters exist for Gemini Generate Content only. Interactions, OpenAI, and Anthropic adapters
  are small: tool declarations are already plain JSON Schema.
- Uploads are buffered in memory by the host route; stream to disk for files over ~100 MB.

## Extracting to its own npm package

This folder is built to move out as-is. `test/boundary.test.ts` fails if any source file imports
something outside the folder other than `node:` built-ins and the optional peers.

1. Move `packages/large-files` to its own repository and add a build (`tsc` or `tsup`) that emits
   `dist/*.js` and `dist/*.d.ts`; point `exports` at `dist`.
2. Pick the final name, remove `"private": true`, set the version, add CI that runs the tests.
3. Publish, then in this app replace imports of `../../packages/large-files/src/index.js` with
   the package name.
