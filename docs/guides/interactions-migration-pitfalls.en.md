# Moving from generateContent to Interactions: common pitfalls

This guide is for any Gemini app that moves from **generateContent** (stateless: you send the whole
conversation each time) to the **Interactions API** (stateful: Google keeps the conversation and you
chain turns with `previous_interaction_id`). It is general, not tied to this repository.

It covers three things:

- the field-by-field mapping, with a column that says what to change;
- the tool and function-calling mistakes that break a migration or add extra rounds;
- how files are sent and kept, especially inline files;
- the reasons an app gets slower than the same calls made by hand in Postman.

Everything marked as tested was checked live on 2026-10-28 with `gemini-3.8-flash` on the Gemini
Developer API (`v1`) and on Vertex AI (`v1beta1`, `locations/global`). See [§9](#9-how-this-was-verified).

---

## 1. Mapping: what changes

| What | generateContent | Interactions | What to change |
| --- | --- | --- | --- |
| Endpoint | `POST …/models/{model}:generateContent`, or `:streamGenerateContent?alt=sse` | `POST …/interactions` (Developer API `v1`; Vertex `v1beta1` in `locations/global`) | New URL. The model moves into the body as `model`. Streaming becomes `stream: true` |
| Conversation | The whole history in `contents`, every request | `previous_interaction_id` plus only the new input | Stop resending history when you chain |
| Input | `contents: [{ role, parts: [{ text }] }]` | `input: "text"`, or `input: [{ type: "user_input", content: [{ type: "text", text }] }]` | Roles become typed steps (`user_input`, `model_output`) |
| Files, inline | `parts: [{ inlineData: { mimeType, data } }]`, sent again on every turn | `{ type: "image" \| "document", mime_type, data }` inside a `user_input` step, sent once | Send each file once; keep your own copy. See [§4](#4-files) |
| Files, uploaded | `parts: [{ fileData: { fileUri, mimeType } }]` | `{ type: "document", uri, mime_type }` | The chain keeps only the link, which expires. See [§4.6](#46-uploaded-files-files-api-break-chains) |
| System prompt | `systemInstruction: { parts: [{ text }] }` | `system_instruction: "…"` | A plain string. **Send it on every request** |
| Settings | `generationConfig: { thinkingConfig: { thinkingLevel }, stopSequences, maxOutputTokens }` | `generation_config: { thinking_level, stop_sequences, max_output_tokens }` | snake_case, thinking level is flat. **Send it on every request** |
| JSON output | `generationConfig: { responseMimeType, responseSchema }` | `response_format: { type: "text", mime_type: "application/json", schema }` at the top level | Move it out of the settings. The beta-era `response_mime_type` is rejected on `v1` |
| Your functions | `tools: [{ functionDeclarations: [{ name, description, parameters }] }]` | `tools: [{ type: "function", name, description, parameters }]` | One flat entry per function, each with `type: "function"`. `parameters` is plain JSON Schema with lowercase types (uppercase `OBJECT`/`STRING` was still accepted in testing). **Send them on every request**: the Developer API drops them between turns, while Vertex `v1beta1` carried them over in testing, so don't rely on either |
| Built-in tools | `{ googleSearch: {} }`, `{ urlContext: {} }`, `{ codeExecution: {} }` | `{ type: "google_search" }`, `{ type: "url_context" }`, `{ type: "code_execution" }` | Rename them |
| Calling mode | `toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames } }` | `generation_config: { tool_choice: "any" }`, or `tool_choice: { allowed_tools: { mode: "any", tools: ["name"] } }` | Move it into `generation_config`. Values are lowercase: `auto`, `any`, `none`, `validated` |
| A call is waiting | `finishReason: "STOP"` and a `functionCall` part | `status: "requires_action"` | Branch on `status`, not on "is there text" |
| The call | Part `functionCall: { name, args, id }`, with `thoughtSignature` on the same part | Step `{ type: "function_call", id, name, arguments }`, after a `thought` step that holds the signature | Read `steps`. `args` is now `arguments` |
| Sending the result | The whole history, the model's content, then `{ role: "user", parts: [{ functionResponse: { name, id, response } }] }` | `previous_interaction_id` plus `input: [{ type: "function_result", call_id, name, result }]` | Send only the result. `call_id` is the call's `id` |
| Result value | `response` is an object | `result` takes an object or a list of content parts. A plain string reached the model on the Developer API, but Vertex accepted it and then lost it | Send an object or `[{ type: "text", text }]`, never a bare string |
| Several calls at once | Several `functionCall` parts | Several `function_call` steps | Return every result in one request |
| Thought signatures | You must echo them. Dropping one gives a clear 400 | Stateful: Google keeps them. With `store: false`: send every returned step back unchanged | Prefer stateful; then there is nothing to do |
| Streaming a call | The `functionCall` part arrives whole | `step.start` gives `id` and `name` (with empty `arguments`), then `step.delta` of type `arguments_delta` gives `arguments` as a **JSON string** | Concatenate the string, then `JSON.parse` it |
| End of the stream | The stream ends | `interaction.completed` (also when `status` is `requires_action`), then `[DONE]`. That final event carries no steps | Build the call from the step events, not from the final event |
| Text of the answer | `response.text`, or `candidates[0].content.parts` | `model_output` steps (the SDKs also offer `output_text`) | Join the text of every `model_output` step: `output_text` skips text that comes before a tool step |
| Usage | `usageMetadata.promptTokenCount`, `thoughtsTokenCount` | `usage.total_input_tokens`, `usage.total_thought_tokens`; when streaming, only on `interaction.completed`. On a chained turn Vertex puts the full context in `total_input_tokens`. The Developer API always has it in `initial_input_tokens`; its `total_input_tokens` covered only the new input on a text-only chain, but everything once the history held a file | Rename your metrics, read the stream to the end to get them, and don't compare token counts across providers |
| Automatic function calling (Python SDK) | Available | Not available yet | Write the call → run → result loop yourself |
| Remote MCP servers | — | Not for Gemini 3 yet | Call MCP from your own code as normal functions |

### The minimal tool loop

```js
const settings = { model, tools, system_instruction, generation_config }; // on EVERY request
let it = await create({ ...settings, input: userText });
for (let round = 0; it.status === "requires_action" && round < 5; round++) {
  const calls = it.steps.filter((step) => step.type === "function_call");
  const input = await Promise.all(calls.map(async (call) => ({
    type: "function_result", call_id: call.id, name: call.name,
    result: await runTool(call.name, call.arguments),
  })));
  it = await create({ ...settings, previous_interaction_id: it.id, input });
}
```

---

## 2. Errors you get from old field shapes

| You sent | Google answers (HTTP 400) |
| --- | --- |
| `tools: [{ googleSearch: {} }]` | `The 'type' parameter is required at 'tools[0]'.` |
| `toolConfig` | `Unknown parameter 'toolConfig'.` |
| `tool_choice` at the top level | `Unknown parameter 'tool_choice'.` |
| An input of `type: "function_response"` | `The value 'function_response' is not supported for 'type' at 'input[0]'.` |
| `response_mime_type` on the Developer API `v1` | `The field 'response_mime_type' is only available in v1beta.` (Vertex `v1beta1` still accepts it) |
| `store: false` history without the `thought` step | `Request contains an invalid argument.` (no hint at all) |

---

## 3. Tool pitfalls

1. **`requires_action` treated as an error or as the end.** A turn that asks for a function ends with
   `status: "requires_action"`, and when streaming, the terminal event is still `interaction.completed`.
   Code that accepts only `completed` fails on the first tool call. Code that saves the interaction ID only
   on `completed` loses the chain.
2. **Not resending tools, the system prompt and settings.** Google's docs say only the conversation is
   inherited. Tested on both providers:
   - a `system_instruction` from the first turn is ignored on the next turn;
   - `stop_sequences` from the first turn no longer apply.

   Tools differ by provider. On the Developer API, a tool declared earlier but never used is not available
   unless `tools` is sent again. On Vertex `v1beta1` it stayed callable without resending, so an app
   tested only on Vertex can break when moved to the Developer API. Resend all three on every request.

   Even on the Developer API, a request without `tools` can still return a call to a tool the model saw
   earlier in the conversation. Handle `function_call` steps on every response.
3. **Resending the history together with `previous_interaction_id`.** The model reads the context twice.
   Tested: the duplicated request carried about 270 extra input tokens on both providers, the size of the
   history that was sent again.
4. **Returning only some results for parallel calls.** In testing, the model did one of three things:
   called the missing tool again (an extra round), answered with only the result it had, or made up the
   missing value. Return every result in one request, and run the calls in parallel.
5. **Matching results to calls by order or name.** Google does not check `call_id`: a wrong ID is accepted
   silently. Match on `id`, especially with parallel calls to the same function.
6. **Parsing streamed arguments as an object.** In a stream, `arguments` arrives as a JSON string in
   `arguments_delta` events. In a non-streamed response it is an object.
7. **Leaving `tool_choice: "any"` on.** It forces a call even for "say hello". If you set it for the first
   round, set it back to `auto` when you send the results.
8. **Relying on `tool_choice: "none"`.** With tools still attached and a prompt that asks for one, the
   request failed with HTTP 400 `malformed_tool_call` ("Model generated invalid JSON syntax…") in most
   tries on both providers (2 or 3 of every 3 across runs): the model tried to call anyway. Catch that error and retry once. To really
   turn tools off on the Developer API, leave them out of the request.
9. **Sending a result as a bare string.** On Vertex the request succeeded but the model answered that the
   tool returned no data. Send an object or a list of content parts.
10. **`store: false` without the full echo.** Every returned step must come back unchanged, including the
    `thought` step. Otherwise you get a 400 with no explanation.
11. **Built-in tools on every turn.** `google_search`, `url_context` and `code_execution` run on Google's
    side. They never cause `requires_action`, but they add steps (for example `google_search_call` and
    `google_search_result`) before the answer starts. Turn them on only for turns that need them.
12. **Too many tools.** Each definition is sent on every request and costs tokens. Large lists also make
    tool choice slower and less accurate.
13. **Every function call is a full extra round, in either API.** Count the rounds per answer. A prompt that
    says "always look up X first" often adds one or two.

---

## 4. Files

Most chat apps send attachments **inline**: the file's bytes, base64-encoded, inside the request. This
section is mostly about that. Everything here was tested on both providers unless it says otherwise.

### 4.1 Sending a file inline

```json
{
  "model": "gemini-3.8-flash",
  "input": [{
    "type": "user_input",
    "content": [
      { "type": "document", "mime_type": "application/pdf", "data": "<base64>" },
      { "type": "image", "mime_type": "image/png", "data": "<base64>" },
      { "type": "text", "text": "Compare the invoice with the photo." }
    ]
  }]
}
```

- **Wrap the content in a `user_input` step.** On the Developer API `v1`, a flat `input: [image, text]`
  (the form most beta examples use) fails with
  `The value 'text' is not supported for 'input[1].type' in v1, it is available in v1beta.`
  Vertex `v1beta1` and the Developer API `v1beta` accept both forms.
- **`data` is plain base64.** A browser's `FileReader.readAsDataURL()` result starts with
  `data:image/png;base64,`, and sending that fails with `Expected string, corrupt base64`. Strip everything
  up to the comma.
- **Always set `mime_type`.** The Developer API guessed it for a PNG; Vertex rejected the request
  (`Missing/unsupported mime_type in image content.`).
- **Put the question after the files**, as Google's document guide recommends.
- **Limits** (from the docs): 100 MB per request, and 50 MB or 1,000 pages for a PDF. Base64 makes a file
  about a third bigger, so a 75 MB file is already over the request limit.

### 4.2 Which files work

| File | Developer API `v1` | Vertex `v1beta1` | How the model reads it |
| --- | --- | --- | --- |
| PDF (`type: "document"`) | ✅ | ✅ | As page images plus text: about 518 tokens per page in testing, counted under the `image` modality |
| PNG, JPEG (`type: "image"`) | ✅ | ✅ | 1,089 tokens for a small image at the default resolution |
| `text/plain`, `text/markdown`, `text/csv`, `text/html` (`type: "document"`) | ✅ | ✅ | As plain text: formatting and HTML tags are lost |
| `application/json` (`type: "document"`) | ✅ | ❌ `mimeType … application/json, which is not supported` | Send it as `text/plain` or as a text item |
| DOCX, PPTX, XLSX | ❌ | ❌ `Request contains an invalid argument.` | Convert to PDF, or extract the text first |

Audio and video use the same item shape (`type: "audio"`, `type: "video"`) according to the docs; they
were not tested here.

### 4.3 What happens after the first turn

- **Sent once, kept in the chain.** Turns 2 and 3, sent with `previous_interaction_id` and no files,
  still read the PDF and the image. A new interaction did not see them.
- **Re-read on every turn.** The file's tokens are counted again on every chained turn: a 12-page PDF
  added 6,216 input tokens to each of four turns. Implicit caching discounted part of it only now and
  then (4,136 tokens on one turn, none on the next two). Inline files are cheap to send, not to keep.
- **Stored at Google.** A GET on the interaction returns the base64 bytes. They stay until the
  interaction expires (Developer API: 55 days paid, 1 day free; Vertex preview: 7 days) or you DELETE it.
  Deleting the chat in your app does not delete Google's copy.
- **Gone after DELETE or expiry.** Continuing a deleted chain fails with
  `404 Requested entity was not found.`
- **Upload size barely mattered.** In one test per provider on a fast connection, sending a 5 MB image
  again with the next turn (3.4–4.0 s) was not slower than chaining without it (6.2–7.6 s). The model's
  own time dominates. Upload size matters on slow links and for the 100 MB limit.

### 4.4 When every file must be sent again

Inline files live only inside the chain. When the chain can't be used, all of them must be sent again
from your own copy:

- the interaction expired or was deleted;
- the app switched model or provider, or rebuilds after a stopped or failed turn;
- `store: false`, where every request carries the full history.

Keep your own copy of every file (this repository keeps them in IndexedDB), and send generated images
back as `model_output` content. A rebuild puts every file of the conversation into one request, so a long
chat can pass the 100 MB limit even though each turn was small. Check the total before rebuilding, and
tell the user if old files have to be dropped.

### 4.5 Keeping file cost down

- **Image resolution.** A per-item `resolution` field changed image tokens only on the Developer API:
  `low` 256, `medium` 529, `high` and the default 1,089. Vertex accepted the field and ignored it. On PDF
  documents both providers rejected it (`Unknown parameter 'resolution'`), although the docs list it for
  PDFs too.
- **Attach a file once.** It is already in the chain; attaching it again in a later turn adds a second copy.
- **Extract the text when layout doesn't matter.** One line of text as a document cost about 20 tokens;
  the same line as a one-page PDF cost about 518.

### 4.6 Uploaded files (Files API) break chains

`{ type: "document", uri, mime_type }` stores only a link in the chain, and Files API uploads expire
after 48 hours. After the uploaded file was deleted (the same as expiring), every later turn of the chain
failed with `403 You do not have permission to access the File … or it may not exist.`, even turns that
didn't mention the file.

With generateContent you own the history, so you can re-upload and swap the link. In Interactions the link
is fixed in Google's copy, so you must start a new chain with a fresh upload. For chat attachments, inline
is the safer default. Use uploads for files above the inline limit, and track their expiry.

---

## 5. Why the app is slower than Postman

Postman usually sends one small, warm request. An app adds state, settings, a server and a UI.

1. **Context that grows.** History resent with `previous_interaction_id` (§3, pitfall 3), long chains, and
   files attached early that stay in the context forever. Compare at the same turn number.
2. **A different body.** Look for tools that are on, `tool_choice: "any"`, no `thinking_level` (the
   model's default is medium or high), and thought summaries. Also check `service_tier`: responses show
   `"service_tier": "standard"` unless you request priority. Log the exact body your server sends and
   replay it in Postman.
3. **Buffered streaming.** Compression middleware, nginx (`proxy_buffering`), API gateways and corporate
   proxies can hold the stream until it ends. Send `Cache-Control: no-transform` and
   `X-Accel-Buffering: no`, flush the headers early, and keep SSE out of compression.
4. **Waiting for the stream to close.** After `interaction.completed` the stream can stay open:
   3 ms to 1.1 s in testing. Unlock the UI on `interaction.completed` and let the rest drain in the
   background.
5. **Extra round trips.**
   - a GET on the interaction after creating it;
   - polling when you use `background: true`;
   - recovering from an expired `previous_interaction_id`, which costs a failed request plus a full
     resend of the history.

   Stored interactions expire: on the Developer API after 55 days on the paid tier (configurable down to
   7 days) and 1 day on the free tier; on the Vertex preview after 7 days.
6. **Chain breaks that silently resend everything.** Switching models, or a stopped, failed or
   `incomplete` turn, often makes apps fall back to sending the full history. `incomplete` is common when
   `max_output_tokens` is low, because thinking shares that budget.
7. **Vertex login on the request path (Node).**
   - Creating a new `GoogleAuth` per request redoes credential discovery and the token exchange.
   - If no project ID is passed (and `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` are unset), the library
     runs the gcloud CLI to find one. That took 2–13 s on a Windows dev machine.

   Keep one client, pass `projectId`, refresh before expiry, and warm it at startup.
8. **No connection reuse (Node).** The built-in `fetch` closes idle connections after about 4 s, so
   almost every human-paced turn pays a new TLS handshake (about 80–90 ms measured). Use an undici
   `Agent` with a longer `keepAliveTimeout`.
9. **Nothing on screen while the model thinks.** Google sends no events until thinking is done. Show your
   own "Thinking…" state as soon as the request starts, or turn on thought summaries.
10. **Front-end rendering.** Re-rendering every message and re-parsing all the markdown on each chunk,
    or saving the whole chat to storage on each chunk, gets slow as answers grow. Postman renders nothing.
11. **Measuring the wrong thing.** Start your timer before login and body building, and record auth time,
    time to first token, and time to completion separately.

---

## 6. Why the first turn of a new chat is slow

- A cold login token, a cold connection and possibly a cold server instance (§5, pitfalls 7 and 8).
- Work the app does only for a new chat, awaited before the model call: creating the session, loading
  user data, retrieval, or a second model call that writes a chat title.
- The heaviest prompt: the full system instruction, tool definitions and attachments, with nothing reused
  yet. Keep the fixed part of the prompt first and per-session data (names, dates, IDs) last, so the
  repeated beginning can be cached.
- High thinking with an empty screen (§5, pitfall 9).

---

## 7. Migration checklist

- [ ] New URL, `model` in the body, `stream: true`.
- [ ] Tools flattened to `{ type: "function", … }`; built-in tools renamed to `{ type: "…" }`.
- [ ] `tool_choice` inside `generation_config`, lowercase.
- [ ] `tools`, `system_instruction` and `generation_config` sent on **every** request, including
      function-result rounds.
- [ ] Follow-ups send only `previous_interaction_id` and the new input.
- [ ] `requires_action` handled as "run the tools", not as an error or as done.
- [ ] Results matched by `call_id`; all parallel results returned in one request.
- [ ] Results sent as an object or a content list, never a bare string.
- [ ] A `malformed_tool_call` 400 retried once.
- [ ] Inline files inside a `user_input` step, as plain base64 (no `data:` prefix), always with `mime_type`.
- [ ] Office files converted to PDF or text; JSON sent as text on Vertex.
- [ ] A local copy of every file for rebuilding a chain, with the total checked against the 100 MB limit.
- [ ] Files API uploads tracked against their 48-hour expiry, or not used for chat attachments.
- [ ] Streamed `arguments_delta` strings concatenated, then parsed.
- [ ] UI unlocked on `interaction.completed`; the interaction ID saved even when the user stops later.
- [ ] A round limit on the tool loop.
- [ ] Timing logged from request start, with auth, first token and completion split out.

---

## 8. Not checked live, or not stable

- Automatic function calling and remote MCP support come from the docs, not from tests.
- What the model does after partial results (§3, pitfall 4) and how often `tool_choice: "none"` fails
  (pitfall 8) change from run to run. The live check reports them without failing.
- Vertex carrying tools over (pitfall 2) and losing string results (pitfall 9) were seen on the
  `v1beta1` preview and may change when it reaches a stable version.
- An earlier test in this repository saw Vertex reject an immediate follow-up with
  *"invalid state (current state: IN_PROGRESS)"* after the stream was cancelled at
  `interaction.completed`. A re-test on 2026-10-28 (cancelling at the terminal event, then sending a
  function result or a text follow-up) did not reproduce it on either provider. Reading the stream to its
  end is still the safe default.
- The retention periods in pitfall 5 come from documentation: the Developer API figures from Google's
  Interactions overview (2026-10-28), and the Vertex figure from this repository's
  [Interactions guide](interactions.en.md).
- The SDK `output_text` behavior in §1 comes from Google's migration guide; the check calls REST only.
- Audio, video, Cloud Storage and external-URL files were not tested. The 100 MB, 50 MB and 1,000-page
  limits in §4 come from Google's docs.
- The `resolution`, caching and 5 MB upload numbers in §4 come from one-off tests on 2026-10-28, not from
  the live check.

---

## 9. How this was verified

Run `npm run check:interactions-tools` (or add `-- gemini` / `-- vertex`). It calls Google directly with
small requests, low thinking and `gemini-3.8-flash` (set `CHECK_MODEL` to change it). It checks:

- the generateContent baseline (call shape, signature required);
- the Interactions call shape, `requires_action`, and the result formats (string results per provider);
- that a wrong `call_id` is accepted;
- `tool_choice` (`any`, `none`, `allowed_tools`) and parallel calls;
- what is inherited: tools per provider, the system prompt, `generation_config`;
- the doubled-context token count, and how each provider reports usage on chained turns;
- `store: false` with and without the `thought` step;
- every old-shape error in §2;
- JSON output with `response_format`, and uppercase schema types;
- `google_search`, and the streaming event shapes;
- inline files: the `user_input` wrapper, files kept and re-counted across turns, GET and DELETE, the
  `data:` prefix and `mime_type` errors, which document types work, and a chain broken by a deleted
  Files API upload.

On 2026-10-28 it passed on both the Gemini Developer API (`v1`) and Vertex AI (`v1beta1`, global); one
Vertex check needed a retry after a network error.

The speed numbers in §5 come from a latency review of this repository on the same day: Node 22.18 on
Windows, measured against `aiplatform.googleapis.com` and `generativelanguage.googleapis.com`.

## Official references (reviewed 2026-10-28)

- [Migrating to the Interactions API](https://ai.google.dev/gemini-api/docs/migrate-to-interactions)
- [Interactions overview](https://ai.google.dev/gemini-api/docs/interactions)
- [Function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)
- [Stable Interactions API reference](https://ai.google.dev/api/interactions-api-v1)
- [Google Cloud Interactions API reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api)
