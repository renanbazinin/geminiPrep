# Gemini Prep

Gemini Prep is a local, stateful Gemini chat and endpoint learning lab. It combines a modern
streaming chat interface with focused, documented experiments that help explain how Gemini
behaves across Google Cloud surfaces.

The main chat supports Gemini's **Interactions API** with persistent conversation references,
streaming, built-in tools, and expanded settings. Select **Vertex AI → Interactions** for your
Google Cloud project and ADC, or **Gemini Developer API → Interactions** for an API key.
Existing provider selections and chats are preserved. See the
[Interactions guide](docs/guides/interactions.en.md) for controls, migration, and limitations.

Gemini 3.8 Flash is available on both providers and is the default for fresh browser settings.
Existing model selections are preserved. If an older local environment list hides it, add
`gemini-3.8-flash` to `VERTEX_CHAT_MODELS` (or its `VERTEX_PROBE_MODELS` fallback) and
`GEMINI_CHAT_MODELS`, then restart the server.

Every new assistant turn also keeps a collapsible local debug trace. It records the browser API
request, the sanitized provider request, HTTP/SSE response metadata, usage, timing, event counts,
errors, and cancellation state. Provider credentials are replaced with `[REDACTED]`. Very large
history/parts are cut in the middle with an explicit omitted count before persistence, and the
visual preview uses a tighter limit; **Copy JSON** copies the complete stored trace.
The trace also identifies explicit or implicit cache hits from `cachedContentTokenCount` and shows
the cached-token total separately.

Chat messages support up to 10 local files / 20 MB combined. PDF files are sent as native visual
parts. Markdown, JSON, CSV, XML, YAML, and plain text are sent as text parts. DOCX and PPTX files
are unzipped locally and reduced to readable text before generation; legacy binary `.doc` files
are intentionally rejected. File bodies live in browser IndexedDB while conversation JSON keeps
only metadata, preventing large base64 payloads from filling `localStorage`.

## Run locally

Requirements:

- Node.js 22+
- `GEMINI_API_KEY` for Gemini Developer API chat (not needed for Vertex Interactions)
- For Vertex chat and labs: a Google Cloud project with Vertex AI enabled and
  Application Default Credentials (`gcloud auth application-default login`)

Configure the provider you plan to use; both providers are not required for main chat.

Install and start both the local server and browser app:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The API server runs on port 3001 and is proxied by Vite.

## Local data and credentials

- Conversation history and settings are serialized to browser `localStorage`.
- Interactions on either provider keeps conversation state with Google; successful follow-ups send only new input and a stored interaction ID. Legacy Generate Content sends local history each turn. Vertex Interactions uses the global preview endpoint and scopes saved IDs to the configured project.
- Interactions storage can be disabled in Settings. Deleting a local chat does not delete Google's stored interactions.
- Vertex uses Application Default Credentials on the server.
- The Gemini API key is read only from `.env` and is never returned to the browser.
- `.env` is ignored by Git. Use `.env.example` to understand available settings.

## Routes

- `/` — streaming chat and local conversations
- `/settings` — provider, model, memory/storage, tools, reasoning, structured output, image, and generation controls
- `/jira` — DeskFlow Jira space with live tickets and chat actions; see [setup and behavior](docs/guides/jira-demo.en.md)
- `/tests` — bilingual English/Hebrew test lab index
- `/tests/regions` — live Vertex model-by-region availability matrix
- `/tests/cache` — Gemini 3 explicit context-cache lifecycle and cache-hit lab

Every new experiment should receive English and Hebrew guides under `docs/tests/` that explain
its purpose, setup, interpretation, limitations, and the concepts learned while implementing it.
The cache lab performs billable calls only when you press its action buttons; automated tests
mock Google responses and never create cloud cache resources.

For the EU multi-region endpoint, complete cache lifecycle, and name-retrieval troubleshooting,
read the cache lab guide in [English](docs/tests/cache.en.md) or [Hebrew](docs/tests/cache.he.md).
The proposed chatbot integration is documented separately in
[English](docs/guides/context-caching.en.md) and [Hebrew](docs/guides/context-caching.he.md);
those guides distinguish the working lab from the currently unwired automatic chat-cache helper.

## Validation

```powershell
npm test
npm run typecheck
npm run build
```

Automated tests use mocked provider responses and do not spend Google Cloud quota.
