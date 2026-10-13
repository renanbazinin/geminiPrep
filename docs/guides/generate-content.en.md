# Generate Content: the stateless Gemini API (before Interactions)

Before the Interactions API, every Gemini chatbot was built on **Generate Content**: `generateContent`
for one complete reply, and `streamGenerateContent` for a streamed reply. It is still the most widely
used Gemini API. Google says it "remains fully supported", while recommending Interactions for new
development.

This guide explains how Generate Content works, the details that catch people out, and when it is still
the right choice. It is general, and applies to any Gemini chatbot. A short section at the end shows how
this repository uses it.

The core idea: **the server remembers nothing.** Every request carries the whole conversation, and your
application owns the history.

---

## 1. Endpoints and authentication

| Provider | URL | Authentication |
| --- | --- | --- |
| Gemini Developer API | `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | `x-goog-api-key: <key>` |
| Vertex AI, global | `https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/publishers/google/models/{model}:generateContent` | `Authorization: Bearer <ADC token>` |
| Vertex AI, multi-region | `https://aiplatform.{eu\|us}.rep.googleapis.com/v1/projects/{project}/locations/{eu\|us}/…` | Same |
| Vertex AI, single region | `https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/…` | Same |

For streaming, replace `:generateContent` with `:streamGenerateContent?alt=sse`. The reply then arrives
as server-sent events, and each `data:` line is a complete response object holding the next piece.

Generate Content has always had regional and multi-regional endpoints on Vertex. That is still one of its
practical advantages. See §10.

---

## 2. A request

```json
{
  "contents": [
    { "role": "user",  "parts": [{ "text": "Hi, my name is Dana." }] },
    { "role": "model", "parts": [{ "text": "Hi Dana, how can I help?" }] },
    { "role": "user",  "parts": [{ "text": "What is my name?" }] }
  ],
  "systemInstruction": { "parts": [{ "text": "Answer in one sentence." }] },
  "tools": [{ "functionDeclarations": [ /* … */ ] }],
  "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } },
  "generationConfig": {
    "maxOutputTokens": 8192,
    "temperature": 1,
    "thinkingConfig": { "thinkingLevel": "low" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `contents[]` | The conversation, oldest first. `role` is `user` or `model`; the last entry is normally `user` |
| `parts[]` | `text`, `inlineData` (`mimeType` + base64 `data`), `fileData` (an uploaded file's URI), `functionCall`, `functionResponse` |
| `systemInstruction` | Behaviour and role. Sent on **every** request, because nothing is stored |
| `tools`, `toolConfig` | Your functions (`functionDeclarations`) or built-in tools (`googleSearch`, `urlContext`, `codeExecution`); mode `AUTO`, `ANY`, `NONE` or `VALIDATED` |
| `generationConfig` | `maxOutputTokens`, `temperature`, `topP`, `topK`, `stopSequences`, `seed`, `responseMimeType`, `responseSchema`, `responseModalities`, `thinkingConfig`, … |
| `safetySettings[]` | Per-category blocking thresholds |
| `cachedContent` | The name of an explicit cache to prepend (see §4) |

Field names are camelCase. Interactions uses snake_case (`generation_config`).

---

## 3. A response

```json
{
  "candidates": [{
    "content": { "role": "model", "parts": [{ "text": "Your name is Dana.", "thoughtSignature": "…" }] },
    "finishReason": "STOP"
  }],
  "usageMetadata": {
    "promptTokenCount": 41, "candidatesTokenCount": 6, "thoughtsTokenCount": 120,
    "cachedContentTokenCount": 0, "totalTokenCount": 167
  },
  "responseId": "…",
  "modelVersion": "gemini-3.8-flash"
}
```

- **Text** is in `candidates[0].content.parts[*].text`. When streaming, concatenate the text of every chunk.
  Skip parts marked `"thought": true`, which only appear if you ask for thought summaries with
  `thinkingConfig.includeThoughts`.
- **`finishReason`** says why it stopped. The common values are `STOP`, `MAX_TOKENS`, `SAFETY`,
  `RECITATION`, `MALFORMED_FUNCTION_CALL`, `MISSING_THOUGHT_SIGNATURE`, and `CONTINUATION` (see §8). A blocked
  prompt has no candidates and has `promptFeedback.blockReason` instead.
- **`usageMetadata`** is your bill. `thoughtsTokenCount` is billed as output and counts toward
  `maxOutputTokens`. `cachedContentTokenCount` shows tokens served from a cache, implicit or explicit.
- A streamed **function call** arrives complete in a single chunk.

---

## 4. Memory is your job

Every turn, the client appends the user's new message, sends **everything**, then appends the model's
reply to its own history.

```text
turn 1:  [u1]                   → m1
turn 2:  [u1, m1, u2]           → m2
turn 3:  [u1, m1, u2, m2, u3]   → m3
```

What follows from that:

- **Cost and latency grow with each turn**, because input tokens are the entire history. A long chat sends
  its early messages again and again.
- **Implicit caching** softens this: Google automatically discounts a repeated prefix of a prompt.
  Keep stable material (system instruction, files) at the start and append new turns at the end, so the
  prefix stays the same.
- **Explicit caching** (`cachedContents`) stores large static material, such as manuals or contracts, once,
  with a TTL. You then send `cachedContent` plus only the new turns. Storage is billed for as long as the
  cache lives, and a cache is tied to one model and location. Some newer models do not support it at all;
  Gemini 4 is one.
- **History limits are yours.** When the conversation outgrows the context window, you decide whether to
  trim, summarise, or refuse. The API will not do it for you.
- **Privacy is simple:** apart from implicit caching and logging policy, Google keeps no conversation state.
  Deleting the chat locally really deletes it.

---

## 5. Thinking

Gemini 2.5 and later think before answering. You control how much:

| Field | Models | Notes |
| --- | --- | --- |
| `thinkingConfig.thinkingLevel` | Gemini 3.x and 4 | `minimal` / `low` / `medium` / `high`. Supported values vary by model, and Gemini 4 rejects `minimal` |
| `thinkingConfig.thinkingBudget` | Gemini 2.5 | A token budget. Gemini 4 rejects it with HTTP 400 |
| `thinkingConfig.includeThoughts` | All thinking models | Return thought *summaries* as parts with `thought: true` |

Thinking shares `maxOutputTokens` with the answer. If a reply stops with `MAX_TOKENS` after very few
visible words, the thinking used up the budget. Raise `maxOutputTokens` or lower the thinking level.

---

## 6. Thought signatures: the biggest catch

Thinking models attach an encrypted **`thoughtSignature`** to parts of their reply. It carries the model's
reasoning state into the next request, which matters because Generate Content keeps no state itself.

| Rule | Detail |
| --- | --- |
| Where it appears | On the first `functionCall` part of a response, or on the last part of a reply without function calls |
| Function calling, Gemini 3 and 4 | **Mandatory.** Return the part containing the signature unchanged. Missing it gives a 400 validation error |
| Sequential calls | Every step in the current turn needs its signature back. A turn starts at the latest user message that is not a `functionResponse` |
| Parallel calls | Only the first call carries a signature. Send all calls, in their original order, then all responses; interleaving them gives a 400 |
| Plain text turns | Returning it is recommended but not enforced |
| Gemini 2.5 | Optional |

Practical rule: **store whole `Part` objects from the model, not just the text or the function arguments.**
The official SDKs do this automatically when you append the full response to the chat history. Hand-built
REST clients are the ones that break. Interactions removes this problem: in stateful mode the server keeps
the signatures.

---

## 7. Function calling round trip

```text
1. request:  contents + tools (functionDeclarations), mode AUTO
2. response: parts: [{ functionCall: { name, args }, thoughtSignature }]
3. you run the function
4. request:  contents + the model's functionCall part (unchanged) +
             { role: "user", parts: [{ functionResponse: { name, response: { … } } }] }
5. response: the final text answer (or another call)
```

Each round trip sends the whole history again, the tool definitions included. Built-in tools such as
`googleSearch`, `urlContext` and `codeExecution` run on Google's side and need no step 3. Search results
come back in `groundingMetadata`.

**Structured output** needs no tools. Set `responseMimeType: "application/json"` and a `responseSchema`
(or `responseJsonSchema`) in `generationConfig`.

---

## 8. Very long answers (Gemini 4 long decode)

A single request produces up to 65,536 output and thinking tokens. Gemini 4 can go further, up to about
1M tokens, through **continuation**:

1. The response stops with `finishReason: "CONTINUATION"` and a `continuationToken`.
2. You resend the same request (contents, system instruction and tools) plus that `continuationToken`.
3. You repeat until `finishReason` is `STOP`, joining the text. `maxOutputTokens` is cumulative across
   the loop.

On Vertex this works only on the `v1beta1` endpoint, and each request has a 20-minute limit. The Google
Gen AI SDK runs the loop for you (`automatic_continuation`).

---

## 9. Generate Content vs Interactions

| | Generate Content | Interactions |
| --- | --- | --- |
| State | None. Resend the history every turn | Stored by Google; send `previous_interaction_id` and the new input |
| Input | `contents[]` with `role` + `parts` | `input` (text, or typed steps) |
| Output | `candidates[].content.parts` | A timeline of `steps` (`model_output`, `thought`, `function_call`, …) |
| Streaming | `:streamGenerateContent?alt=sse`, each chunk a full response | `"stream": true`, typed events (`step.start`, `step.delta`, `interaction.completed`) |
| Settings | `generationConfig` (camelCase) | `generation_config` (snake_case), sent again every turn |
| Function results | A `functionResponse` part | A `function_result` input with `call_id` |
| Search | `googleSearch`, citations in `groundingMetadata` | `google_search`, search steps, inline `annotations` |
| JSON output | `responseMimeType` + `responseSchema` | Top-level `response_format` |
| Thought signatures | Yours to return | Kept by the server (stateful mode) |
| Retention | Nothing stored | Stored interactions expire (for example, 7 days on Vertex preview); can be turned off with `store: false` |

---

## 10. When Generate Content is still the right choice

- **You must not store conversations with Google.** Compliance, data retention, or customer contracts.
- **You need a specific region.** On Vertex, Generate Content has regional and multi-regional endpoints.
  For EU-only processing, use the `eu` multi-region.
- **Large static material reused across many chats.** Explicit caching works with Generate Content.
- **You already have history logic.** For example, your own database of turns, summarisation, or an
  OpenAI-style client.
- **Very long single answers on Vertex.** Long decode there exists only on Generate Content.

Choose **Interactions** when you want Google to hold the state, which means smaller follow-up requests,
signatures handled for you, and background agents. That is why Google recommends it for new projects.

---

## 11. In this repository

- **Settings → Conversation API → Generate Content** is the "legacy" mode, per provider. Vertex starts
  in this mode, and the Gemini API starts in Interactions.
- [`server/chat/upstream.ts`](../../server/chat/upstream.ts) builds the request body and the
  endpoint URLs above. It parses the SSE stream, hides `thought` parts, and collects function calls.
- [`server/chat/stream.ts`](../../server/chat/stream.ts) runs **automatic tool routing**. The chat model
  gets `functionDeclarations` with mode `AUTO`. If it calls `generate_image` or `generate_graph`, the server
  makes a second, specialist call on the same stream. It never sends a `functionResponse` back, so the
  thought-signature rules for function calling never apply. See
  [auto-tool-routing.en.md](auto-tool-routing.en.md).
- The browser sends the **full local history** every turn, and keeps only text and files, not signatures.
  That is fine for plain text turns, where signatures are optional.
- The Vertex **region** selector applies only in this mode. Interactions always uses `global`.
- The [context cache lab](../tests/cache.en.md) and the [caching guide](context-caching.en.md) cover explicit
  caching, which belongs to this API.
- Gemini 4 works in this mode as well. See [gemini-4.en.md](gemini-4.en.md).

## Moving a Generate Content bot to Interactions

1. Replace `contents` with `input`, and on follow-ups send only the new input plus `previous_interaction_id`.
2. Rename `generationConfig` to `generation_config` (snake_case), and send it, `system_instruction` and
   `tools` again on every turn. They are not inherited.
3. Read `steps` instead of `candidates`. Text is in `model_output` steps.
4. Map function results to `function_result` with `call_id`.
5. Decide on retention: `store: true` (stateful), or `store: false` and keep sending history yourself.
6. Keep your local transcript. Stored interactions expire, and you will want to rebuild from local history
   (this repo's Interactions mode does exactly that).

## Official references (reviewed 2026-10-13)

- [Generate Content API reference](https://ai.google.dev/api/generate-content)
- [Migrate to the Interactions API](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)
- [Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
- [Thinking](https://ai.google.dev/gemini-api/docs/thinking)
- [Vertex thought signatures](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures)
