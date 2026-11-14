# Gemini Prep

Gemini Prep is a local, stateful Gemini chat and endpoint learning lab. It combines a modern
streaming chat interface with focused, documented experiments that help explain how Gemini
behaves across Google Cloud surfaces.

The main chat supports Gemini's **Interactions API** with persistent conversation references,
streaming, built-in tools, and expanded settings. Select **Vertex AI → Interactions** for your
Google Cloud project and ADC, or **Gemini Developer API → Interactions** for an API key.
Existing provider selections and chats are preserved. See the
[Interactions guide](docs/guides/interactions.en.md) for controls, migration, and limitations.
The [images in Interactions guide](docs/guides/interactions-images.en.md) covers input, generation,
editing, v1/v1beta, regions, every exposed image option, and live compatibility results. Developer
image generation works after omitting the unsupported delivery field; Vertex Interactions rejected
the app's pinned image-generation model in the 2026-11-01 live check.
The older stateless **Generate Content** API (still available as the legacy mode) is explained in a general
guide in [English](docs/guides/generate-content.en.md) and [Hebrew](docs/guides/generate-content.he.md).
Common pitfalls when moving an app from Generate Content to Interactions (tool mapping, inheritance,
inline files, and why an app gets slower than Postman) are in [English](docs/guides/interactions-migration-pitfalls.en.md)
and [Hebrew](docs/guides/interactions-migration-pitfalls.he.md); `npm run check:interactions-tools` re-checks them live.

Gemini 3.8 Flash is available on both providers and is the default for fresh browser settings.
Existing model selections are preserved. If an older local environment list hides it, add
`gemini-3.8-flash` to `VERTEX_CHAT_MODELS` (or its `VERTEX_PROBE_MODELS` fallback) and
`GEMINI_CHAT_MODELS`, then restart the server.

The **Gemini 4 · Pro** switch in the chat top bar (also in Settings) moves new turns to Gemini 4 Argon
(`gemini-4-argon`, paid tier only) on either provider and API mode, and switches back to your saved model.
It is always offered, even when the lists above are narrowed. On Vertex, Gemini 4 is served only from
`global`, `us` and `eu`. See the guide in [English](docs/guides/gemini-4.en.md) or
[Hebrew](docs/guides/gemini-4.he.md) for what changes in the API and how it was verified.

Every new assistant turn also keeps a collapsible local debug trace. It records the browser API
request, the sanitized provider request, HTTP/SSE response metadata, usage, timing, event counts,
errors, and cancellation state. Provider credentials are replaced with `[REDACTED]`. Very large
history/parts are cut in the middle with an explicit omitted count before persistence, and the
visual preview uses a tighter limit; **Copy JSON** copies the complete stored trace.
The trace also identifies explicit or implicit cache hits from `cachedContentTokenCount` and shows
the cached-token total separately.

Chat messages support up to 10 files. Small files stay in the browser: PDF files are sent as
native visual parts; Markdown, JSON, CSV, XML, YAML, logs, and plain text are sent as text parts;
DOCX and PPTX files are unzipped locally and reduced to readable text; legacy binary `.doc` files
are intentionally rejected. File bodies live in browser IndexedDB while conversation JSON keeps
only metadata, preventing large base64 payloads from filling `localStorage`.

**Large files** (books, logs, big exports, up to 100 MB) are uploaded to the server instead: text,
DOCX and PPTX over 512 KB and PDFs over 7 MB by default (a DOCX or PPTX whose text is longer than
that goes too). A smaller file is sent to Gemini as it is, without counting its tokens. Each turn,
the server decides whether an uploaded file fits the model's limits (by default 200K tokens of file
text, within 10 MB per request and a 1M-token context) and sends it in full, or gives Gemini
a summary card plus tools to search, read line ranges, or read the whole file in parts. The steps
Gemini took appear under its answer. Limits are set with the `LARGE_FILES_*` variables in
`.env.example`.

**Pictures in large PDFs.** The text of a PDF does not hold its pictures. With the npm engine the
server keeps each uploaded PDF next to its text until it expires, marks the pages that show a
picture, and gives Gemini a `view_pages` tool: Gemini asks for up to five pages and gets them as a
small PDF, so it can read a chart, a photo, or a scanned page. A scanned PDF with no text is
accepted up to 30 pages. Each look is one of the steps under the answer, for example
`Look at report.pdf pages 12-14`, and costs about 530 tokens a page.

Page views run in a Generate Content chat with no image or graph tool picked. With the
Interactions API, or with a tool picked, a PDF that fits is read from its text alone, as before.
While a chat holds a PDF that Gemini can look at, Gemini does not hand a turn to the image or
graph tool by itself (the same as for a file it has to search): pick the tool yourself.
`LARGE_FILES_KEEP_PDFS=0` turns page views off. `npm run check:large-files-pages` asks Vertex AI
and the Gemini API questions that only the pictures of a PDF answer.

**A second model for the searching.** By default the model picked in the chat does both halves of
the work on a large file: it explores the file (searches, reads, looks at pages), and it answers.
`LARGE_FILES_EXPLORER_MODEL` names a second model for the first half, with the npm engine. That
model makes the tool calls and reads a whole file in parts; the picked model gets what the tools
returned and writes the answer, in one request. A question about a large log can take ten requests
of searching, and those then go to the explorer, which can be a cheaper or faster model. The steps
under the answer are the same, and the answer takes one request more. Unset, nothing changes.
`npm run check:large-files-explorer` asks Vertex AI and the Gemini API questions through an
explorer and reports which model got which request.

The logic comes from the [`llm-large-files`](https://www.npmjs.com/package/llm-large-files) npm
package by default. `LARGE_FILES_ENGINE` picks the implementation:

| `LARGE_FILES_ENGINE` | What runs |
|---|---|
| `npm` (default) | The published package: its library, its `askGemini` tool loop, and its upload handlers |
| `original` | The in-repo copy in [`packages/large-files`](packages/large-files/README.md) and this app's own tool loop |

Both engines store files the same way and stream the same events to the browser, so switching
only needs a server restart. The startup log names the engine in use.

**Presentations.** The chat makes PowerPoint decks with the
[`slotdeck`](https://www.npmjs.com/package/slotdeck) npm package: it clones the slides of a template
pptx and fills their slots, so the design is never redrawn. Pick **Make a presentation** in the
composer's tools menu (with Generate Content and tools on Auto, just ask for a deck). Gemini first
**plans** the slides and shows the plan as a card of layouts; **Create presentation** (or a message
with changes) comes next, and a created deck can be **changed** by instruction: "shorten slide 3",
"add a table before the closing slide". Only the slides a change touches are rewritten. The chat
model handles ids and short summaries only; plans, deck JSON, pictures and the files stay on the
server.

Templates are made in **Template Studio** (`/templates`): upload a .pptx of sample slides, and the
model drafts which slides are layouts and what each shape is for, from the shapes as measured in
the file (positions, sizes, fonts, sample text). No picture of a slide is sent to the model. Then
correct the draft by clicking shapes or by instruction, download a sample deck that fills every slot
to its budget, and choose the template the chat uses. A demo template ships with the app. The
[presentations guide](docs/guides/presentations.en.md) explains the flow, the settings
(`PRESENTATIONS_*` in `.env.example`) and what was checked live.

## Run locally

Requirements:

- Node.js 22.18+ (the `slotdeck` package needs it)
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

## Password

Set `APP_PASSWORD` in `.env` to put the whole app (pages, API and `/docs`) behind a login page.
Signing in keeps a signed, HttpOnly cookie for 30 days; changing the password signs everyone out.
Leave it empty to run locally without a password. On Cloud Run the server refuses to start without it.

## Deploy to Google Cloud Run

Requirements: the `gcloud` CLI signed in to an account that can manage the project, and
`APP_PASSWORD` plus `GCP_PROJECT` in `.env`.

```powershell
npm run deploy:gcp
```

The script ([scripts/deploy-cloud-run.ts](scripts/deploy-cloud-run.ts)) enables the needed APIs,
creates a `gemini-prep-run` service account with Vertex AI access, stores `APP_PASSWORD`,
`GEMINI_API_KEY` and the Jira tokens in Secret Manager, passes the other `.env` settings as
environment variables, and builds the [Dockerfile](Dockerfile) with Cloud Build. It deploys
service `gemini-prep` to `us-central1`; override with `GCP_PROJECT`, `REGION` or `SERVICE`.
Run it again after changing `.env` or the code.

On Cloud Run the service runs a single instance, and uploaded large files are kept in that
instance's memory, so they are lost when it restarts. Uploads are limited to 30 MB by Cloud Run.
The same holds for templates made in Template Studio and for the decks the chat made: download a
template's manifest to keep it, and put a template that should survive in `presentation-templates/`
(see the [presentations guide](docs/guides/presentations.en.md)).

The foot of the sidebar shows what runs: the `version` in `package.json`, the commit (linked on
GitHub) and the day of the deploy. The image has no git, so the script sets `APP_COMMIT` and
`APP_DEPLOYED_AT` on the service; a commit that ends in `-dirty` means the deployed files had
changes that were not committed. A local run shows the commit of its checkout. Under that line is
the installed version of `llm-large-files`, linked on npm. It is not shown while
`LARGE_FILES_ENGINE` is `original`, because the package then serves nothing.

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
- `/special-group` — read-only Jira ticket assistant that drafts tickets and opens them prefilled in Jira. The general pattern (read-only Jira → prefilled create link → any chatbot) is in four short guides: [English](docs/guides/jira-ticket-links/01-read-only-access.en.md) · [Hebrew](docs/guides/jira-ticket-links/01-read-only-access.he.md)
- `/templates` — Template Studio: turn a .pptx into a template for the chat's presentation tools; see the [presentations guide](docs/guides/presentations.en.md)
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

`npm run check:gemini-4` sends a few small, billable requests through every Gemini 4 chat path on each
configured provider and reports which ones work.
