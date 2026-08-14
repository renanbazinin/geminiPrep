# Gemini Prep

Gemini Prep is a local, Vertex-first chat and endpoint learning lab. It combines a modern
streaming chat interface with focused, documented experiments that help explain how Gemini
behaves across Google Cloud surfaces.

Every new assistant turn also keeps a collapsible local debug trace. It records the browser API
request, the sanitized provider request, HTTP/SSE response metadata, usage, timing, event counts,
errors, and cancellation state. Provider credentials are replaced with `[REDACTED]`; long values
are shortened only in the visual preview, while **Copy JSON** copies the complete stored trace.

## Run locally

Requirements:

- Node.js 22+
- A Google Cloud project with Vertex AI enabled
- Application Default Credentials for Vertex (`gcloud auth application-default login`)
- An optional `GEMINI_API_KEY` for the Gemini Developer API comparison mode

Install and start both the local server and browser app:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The API server runs on port 3001 and is proxied by Vite.

## Local data and credentials

- Conversation history and settings are serialized to browser `localStorage`.
- The server is stateless and receives conversation history with each turn.
- Vertex uses Application Default Credentials on the server.
- The Gemini API key is read only from `.env` and is never returned to the browser.
- `.env` is ignored by Git. Use `.env.example` to understand available settings.

## Routes

- `/` — streaming chat and local conversations
- `/settings` — provider, model, region, system instruction, and generation controls
- `/tests` — bilingual English/Hebrew test lab index
- `/tests/regions` — live Vertex model-by-region availability matrix
- `/tests/cache` — Gemini 3 explicit context-cache lifecycle and cache-hit lab

Every new experiment should receive English and Hebrew guides under `docs/tests/` that explain
its purpose, setup, interpretation, limitations, and the concepts learned while implementing it.
The cache lab performs billable calls only when you press its action buttons; automated tests
mock Google responses and never create cloud cache resources.

## Validation

```powershell
npm test
npm run typecheck
npm run build
```

Automated tests use mocked provider responses and do not spend Google Cloud quota.
