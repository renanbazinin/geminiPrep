# Auto-routing chat tools with Gemini function calling

This is a design guide for adding “the user types a normal message, the model picks the right tool”
to any Gemini chatbot. It is not tied to a particular repo.

The pattern: **the model that is already answering also chooses the tool.** You do not put a cheaper
classifier in front.

---

## 1. The problem

Users will not open a tools menu. They will write:

> generate me an image of a monkey

> draw a flowchart of our auth

> what is a region endpoint?

The first two need specialists (an image model, a diagram renderer). The third is plain chat. The
app has to decide **per turn**, using the conversation, not a keyword list.

A tempting shortcut is “call Gemini Lite, it returns `image | graph | chat`, then call the real
model.” That is usually the wrong default. See §3.

---

## 2. What to build instead

Send the user’s **current chat model** a `generateContent` (or `streamGenerateContent`) request that
includes:

1. The conversation
2. `tools.functionDeclarations` — one declaration per capability
3. `toolConfig.functionCallingConfig.mode = "AUTO"`

The model then does one of two things:

- Streams a normal text answer, or
- Returns a `functionCall` (`name` + `args`) instead of (or before) a final answer

Your server looks up `name` in a **registry**, runs that tool, and continues the same user-facing
stream. The browser still made one HTTP request.

```text
User send
    │
    ├─ UI force-selected a tool ──► specialist only (no planner)
    │
    └─ Auto (default)
            │
            ▼
     Chat model + functionDeclarations AUTO
            │
            ├─ text only ──────────► stream the reply, done
            │
            └─ functionCall
                    │
                    ▼
             registry lookup
                    │
                    ├─ handoff tool ─► second model call (image, diagram, …)
                    └─ loop tool ────► execute, send functionResponse, call the chat model again
```

`AUTO` is Gemini’s native “maybe call a tool, maybe just talk.” Do not reimplement that with an enum
classifier unless you have a measured cost problem.

---

## 3. Why not a Lite router

| | Lite classifier first | Function calling on the chat model |
| --- | --- | --- |
| Extra hop | Every message, including “hello” | Only when a tool is actually chosen |
| Follow-ups | Weak (“make it wearing a hat”) | Sees the same history the answer would see |
| Attachments | Easy to drop or mishandle | Same multimodal request as chat |
| Image gen | Still needs the image model → **three** hops, or you skip prompt rewrite | Planner + specialist = **two** hops, and only on image turns |
| Who trained this | You, via a prompt | The model, via `functionDeclarations` |

Lite-first is a later optimization if planner tokens become a real bill, not the architecture you
start with.

---

## 4. Two kinds of tools (do not hard-code a 2-way `if`)

Keep a small registry. Each entry has a `kind`. Adding a third tool should be another object, not
another branch in the stream handler.

### Handoff

The chat model is the wrong engine for the work. You **switch** to a specialist and stream that
result to the user. You do **not** send a `functionResponse` back into the planner.

Examples:

- Image generation / editing → `gemini-3.1-flash-image` (or whatever image model you use) with
  `responseModalities: ["TEXT", "IMAGE"]`
- Diagrams → same chat model, but a hidden system instruction that forces a fenced Mermaid block,
  then the UI always renders it

Handoff is right when the user should **see the specialist output**, not a summary of it.

### Loop

The tool returns **data the chat model must read** (search hits, a database row, weather). You
execute the function, append `functionResponse`, and call the chat model again until it answers in
text.

Examples: web search, CRM lookup, calculators.

Gemini also has **built-in** tools (`googleSearch`, etc.). Those are not `functionDeclarations`; they
are a different `tools[]` entry. Mix them later; do not confuse them with your handoff registry.

This guide’s v1 is handoff. Design the registry so loop tools can be added without rewriting the
planner.

---

## 5. Force override vs Auto

Give the user a picker: **none / tool A / tool B** (XOR).

| Picker | Server behavior |
| --- | --- |
| None (Auto) | Attach declarations, `mode: "AUTO"` |
| A tool is selected | **Do not** attach declarations. Call that specialist immediately |

Forced mode is faster and more predictable. “Generate image” in the UI should not spend a planner
turn hoping the model agrees.

After an Auto turn, **tag the assistant message** with the tool that ran (`image`, `graph`, …) so
the UI can wrap Mermaid, show the image, and label the bubble. Do **not** flip the sticky picker.
The user did not select a tool; the model did, for this turn only.

Retry of that message may reuse the tag (force the same specialist) or re-run Auto. Forcing is
simpler and matches “try that image again.”

---

## 6. Registry shape

Declarations are what Gemini sees. Metadata is what your server sees. Keep both in one list.

```ts
type HandoffTool = {
  name: string;           // must match FunctionDeclaration.name
  kind: "handoff";
  toolId: "image" | "graph"; // your app’s id, used in UI + SSE
  argumentKey: "prompt" | "request";
  declaration: FunctionDeclaration;
};
```

Declaration quality matters more than clever routing code. The `description` is how the model
decides. Write **when to use it** and **when not to**.

```ts
{
  name: "generate_image",
  description:
    "Generate or edit an image from a text description. Use when the user asks to draw, generate, create, imagine, or modify a picture.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "Full image prompt, including any requested edits to a previous image in the conversation.",
      },
    },
    required: ["prompt"],
  },
}
```

```ts
{
  name: "generate_graph",
  description:
    "Create a Mermaid diagram such as a flowchart, sequence diagram, architecture map, or ER chart. Use when the user asks for a graph, diagram, flowchart, or visual structure.",
  parameters: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "What the diagram should show.",
      },
    },
    required: ["request"],
  },
}
```

Lookup is `registry.find(t => t.name === functionCall.name)`. Unknown names: ignore and finish with
whatever text the planner already streamed. Do not crash the turn.

---

## 7. Request body (planner)

When **no** tool is forced:

```json
{
  "contents": [ /* conversation */ ],
  "systemInstruction": { "role": "system", "parts": [{ "text": "…" }] },
  "tools": [{ "functionDeclarations": [ /* from registry */ ] }],
  "toolConfig": {
    "functionCallingConfig": { "mode": "AUTO" }
  },
  "generationConfig": { "temperature": 1, "maxOutputTokens": 8192 }
}
```

When a tool **is** forced, omit `tools` and `toolConfig`. Set specialist-only config instead (image
modalities, diagram system prompt, …).

`mode` recap:

| Mode | Use |
| --- | --- |
| `AUTO` | Default chat. Model may answer or call a function |
| `ANY` | Must call a function (optional `allowed_function_names`) |
| `NONE` | Forbid function calls |

Forced XOR is cleaner as “skip tools, go to specialist” than as `ANY`, because image generation is a
**different model**. `ANY` on the chat model cannot emit PNG bytes.

---

## 8. One user HTTP request, two model hops

Keep the browser API dumb: `POST /chat/stream` once. The **server** owns the loop.

1. Open SSE. Send `meta` (provider, model, region, sanitized request).
2. Stream the planner. Forward user-visible **text** deltas. Ignore `thought` parts. Buffer
   `functionCall` parts (`name` + `args`; merge incremental args).
3. If the planner ends with **no** function call → `done`.
4. If it ends with a known handoff:
   - Emit `event: tool` with `{ id, name, args, model, region? }`
   - Build a specialist request (see §9)
   - Stream that hop on the **same** SSE (`delta`, `image`, …)
   - Then `done`
5. Do not collect function calls on the specialist hop. Do not recurse.

The client:

- `onTool` → set `message.tool` (and optionally patch the displayed model to the specialist)
- Keep the streaming caret until `done`
- Render images / Mermaid from the same bubble

The user bubble still shows the original wording. Only the **upstream** last user turn uses the
rewritten `prompt` / `request` from `args`. That is how “generate me image of monkey” becomes a
proper image prompt without lying in the transcript.

---

## 9. Building the specialist request

Copy provider, temperature, history. Then specialize.

**Image**

- Model: your image Gemini (e.g. `gemini-3.1-flash-image`)
- Vertex: image models are often **global-only** — force that region even if Settings says `europe-west1`
- `generationConfig.responseModalities = ["TEXT", "IMAGE"]`
- Omit thinking / `thinkingConfig` (image models reject it)
- Put prior generated images back into history as `inlineData` so “make it darker” can edit
- Last user text = `args.prompt` if present

**Diagram**

- Same chat model / region / thinking as the planner
- Append a hidden system instruction: one fenced ` ```mermaid ` block, short caption, no HTML
- Last user text = `args.request` if present
- UI: render fenced Mermaid when the message is complete; if this turn is tagged `graph` and there
  is no fence, treat the whole reply as Mermaid and fall back to a code frame on parse failure

**Both**

- Do not send planner `tools` on the specialist request
- Do not send Vertex `cachedContent` (see §11)

---

## 10. Streaming `functionCall` parts

Planner chunks look like:

```json
{
  "candidates": [{
    "content": {
      "parts": [{
        "functionCall": {
          "name": "generate_image",
          "args": { "prompt": "a monkey sitting on a red stool" }
        }
      }]
    },
    "finishReason": "STOP"
  }]
}
```

Details that bite:

- Args may arrive **incrementally**. Merge objects with the same `name`; take the latest complete
  snapshot if the name changes.
- The planner may stream a short text preamble (“I’ll generate that”) **and** a function call.
  Forward the text, then hand off. Do not drop it, do not treat it as the final answer.
- Filter `thought: true` parts out of the visible stream, same as ordinary chat.
- Image bytes arrive as `inlineData` (`mimeType` + base64). Emit a dedicated `image` SSE event. Store
  blobs in IndexedDB / object storage; **never** persist full base64 in `localStorage` conversation
  JSON. Redact image bytes in debug traces.

Suggested SSE events:

| Event | When |
| --- | --- |
| `meta` | Stream opens (planner request snapshot) |
| `delta` | Visible text from either hop |
| `tool` | Handoff decided (`id`, `name`, `args`, specialist `model`) |
| `image` | Specialist produced inline image data |
| `done` / `error` | Terminal |

---

## 11. Caches, thinking, and other landmines

**Explicit Vertex context cache.** A cache is immutable and was created with a specific tool set (or
none). Sending `functionDeclarations` next to `cachedContent` that was not built with those tools
fails. A graph handoff also adds a system instruction the cache does not contain. An image hop uses
a **different model**. Practical rule: **skip `cachedContent` on Auto planner turns and on every
specialist hop.** Implicit prefix caching on the provider side still applies.

**Thinking.** Keep it on the planner (it helps tool choice). Drop it on the image specialist.

**Do not put the image model in the normal model dropdown.** It is not a general chat model. Route
to it only via the image tool.

**Do not send empty text parts.** If a history turn is image-only, send `inlineData` without a blank
`{ text: "" }` unless the API requires at least one part.

**Tool choice is not a keyword matcher.** “Can you explain how image generation works?” should
**not** call `generate_image`. Good descriptions + `AUTO` handle this better than regex.

---

## 12. Adding the next tool

Checklist:

1. Add a registry entry (`name`, `kind`, `declaration`, how to build the specialist or loop payload).
2. If **handoff**: implement the second hop (model, config, history rewrite). Tag `message.tool`.
3. If **loop**: execute, append `functionResponse`, call the chat model again with the same
   declarations; cap the number of rounds.
4. If **built-in** (Search): add the Gemini built-in tool object; still use `AUTO`.
5. Tests: Auto body includes the new name; forced XOR still omits `tools`; a fake planner
   `functionCall` triggers the second fetch.

You should not need a new `if (tool === "image")` at the top of the stream proxy. Lookup the
registry, then switch on `kind`.

---

## 13. Tests worth writing first

These catch the design, not just the HTTP plumbing.

1. **Auto body** includes `functionDeclarations` and `AUTO`. No `responseModalities`.
2. **Forced image** has **no** `tools` / `toolConfig`, and **does** set `responseModalities`.
3. Planner SSE with `functionCall.name = "generate_image"` causes a **second** fetch to the image
   model, emits `event: tool` then `event: image`, and the specialist last user part is `args.prompt`.
4. Same for `generate_graph`: second fetch stays on the **chat** model, Mermaid system prompt is
   present, no planner tools on that hop.
5. Unknown `functionCall` name does not throw; the stream still `done`s.

---

## 14. Minimal mental model

- **Auto** = chat model + declarations + `AUTO`.
- **Force** = skip the planner, run the specialist.
- **Handoff** = second model call, same SSE, user sees the specialist output.
- **Loop** = `functionResponse` back into the chat model (later).
- **Lite router** = extra hop on every message; skip until you have a cost reason.

That is the whole product: one send button, a model that already knows how to pick a function, and a
registry you can grow.
