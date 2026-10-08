# Stateful Gemini chat

The main chat supports Interactions on both providers. Select **Vertex AI → Interactions** to use your Google Cloud project and Application Default Credentials (ADC), or **Gemini Developer API → Interactions** to use an API key. The Cloud endpoint is `v1beta1` preview in `locations/global`; the Developer API defaults to stable `v1`. Existing provider/model selections and local conversations are preserved. Each provider has its own API-mode selection; existing Vertex settings stay on Generate Content until you choose Interactions. Jira retains its existing request path.

## Google Cloud setup

Configure `GCP_PROJECT` (or the existing supported Cloud project environment variables), enable the Vertex AI / Agent Platform API, and give the calling identity the appropriate IAM access, such as `roles/aiplatform.user`. Use `gcloud auth application-default login` for local ADC, or your deployment's service account. No Gemini Developer API key is required or used for Vertex requests. Credentials stay on the server and are redacted from debug traces.

Cloud Interactions always uses the global endpoint without changing your saved legacy region preference. Its preview retains stored interactions for 7 days. The server reports the actual project with completed IDs; the browser only resumes IDs from the same provider, project, model, and API version. A server project change during a request returns a conflict and asks you to reload, so the browser can rebuild local history for the new project. The client-supplied project never selects a different backend project.

## Conversation behavior

- A new or imported conversation sends its local text, PDFs, extracted document text, and generated images as typed input steps.
- A successfully completed response saves its interaction ID with that assistant message. The next turn sends only new user input and `previous_interaction_id`. The browser retains the local transcript, reference, and selected chat across reloads.
- System instructions, tools, and generation preferences are included on every request; Gemini does not inherit them from the preceding interaction.
- Provider, Cloud project, model, or API-version changes rebuild context from local history. Retrying a response resumes from the previous successful assistant turn, never the response being replaced.
- Failed, stopped, truncated, and token-limited responses do not become continuation anchors. Their usable local history can seed another request.
- **Reconnect from local history** discards this chat's local continuation references. It does not delete the transcript or Google's stored data; the next send/retry starts a new chain.

## Controls

| Area | Available settings |
| --- | --- |
| API and memory | Interactions / Generate Content, stable / beta, stateful / full-history, Google storage opt-out |
| Model and instructions | Configured model, system instruction, maximum output tokens |
| Reasoning | Model default, minimal, low, medium, high; optional provider thinking summaries |
| Text generation | Optional seed and stop sequences; text/Markdown or JSON with an optional JSON Schema |
| Tools | Google Search, URL context, code execution; automatic, disabled, required, or validated tool choice |
| Images | Native image generation using the composer tool menu; aspect ratio and output size |
| Sampling | Temperature and optional top-P on Cloud and Developer beta; omitted from Developer stable v1 |

Settings are saved automatically. Optional values are omitted when empty. The server validates types, limits, and storage/continuation combinations before contacting Google. Individual models may reject unsupported reasoning levels, tool combinations, schemas, or image sizes; those errors are shown without silently changing your settings or retrying generation.

## Expired references and recovery

Google decides whether a saved interaction is still available; the app does not guess from its age. If a continuation fails explicitly because its reference is invalid, missing, deleted, or expired, the app clears this chat's old references and makes **one** fresh request containing the locally saved conversation. A notice appears in the response, and the new completed ID is saved. Other chats are unaffected. This also works after a reload.

Google sometimes returns only `400: Request contains an invalid argument.` For ambiguous 400/404/410 errors, the server checks the saved reference with a read-only GET. A 400/404/410 from that lookup enables recovery. A successful lookup, network failure, authentication error, rate limit, or server error leaves the original error visible and does not trigger generation again.

| Case | Behavior |
| --- | --- |
| Old but still valid reference | Continue normally; age alone does not discard it |
| Confirmed invalid or expired reference | Restore local history once, then save the replacement ID |
| Malformed local reference | Build a fresh request from local history |
| Missing attachment or generated image | Stop with an actionable error; never silently omit the file |
| History exceeds server/model limits | Show the error; never silently trim the conversation |
| Rebuilt request also fails | Show the failure; no recovery loop |
| Authentication, quota, network, or server failure | Show the error; no automatic generation retry |
| Partial response, stream interruption, or Stop | Preserve visible output; do not reuse an unfinished ID or automatically replay |
| Provider/model/API version changes | Rebuild from local history with the newly selected settings |
| Browser storage full or unavailable | Keep the current chat usable and warn that changes may not survive reload |

Restoration uses the local visible transcript and available files. It cannot reconstruct hidden provider reasoning or tool state that was never saved locally. If local history itself is gone, the app cannot recover it using an expired ID. **Reconnect from local history** remains available for a deliberate fresh start.

Use the composer’s image/diagram menu to request a native image or Mermaid diagram. Automatic image handoff remains in Generate Content mode. The Interactions adapter exposes built-in Google tools rather than the old local handoff functions. Search sources and search suggestions are displayed when returned; suggestion markup is isolated in a sandboxed frame with scripts disabled.

## Storage and privacy

Credentials remain on the local server. Debug traces redact authentication headers. Attachments and generated image payloads remain in IndexedDB locally, with metadata in the transcript. Stored interactions also contain the input/output sent to Google.

Turning off **Store interactions with Google** disables stateful continuation and sends full local history with `store: false`. This does not remove previously stored interactions. Deleting a local conversation also does not delete Google's copy. Developer API logs can be managed in AI Studio; Cloud stored interactions belong to the configured project. Retention expiry can invalidate an ID; the recovery behavior above handles confirmed rejection.

Thinking summaries are provider-supplied summaries, shown separately from the answer. Thought signatures and raw thought text are not rendered or copied into the local answer. Token usage and the provider interaction ID remain visible in the response debug trace.

## Scope and verification

This refactor covers the main chat on both providers. It does not migrate Jira or the caching/region labs. Managed agents, background jobs, audio/video generation, remote MCP servers, and arbitrary client function execution need their own lifecycle and UI and are not exposed here. Explicit caching is not used for Interactions; the existing cache lab stays available for Vertex.

Run `npm test` and `npm run build`. Automated tests mock provider responses and cover API mapping, fragmented streaming, continuation/retry, reloads, recovery, project isolation, storage failures, storage opt-out, attachments, images, validation, failure states, settings migration, and UI controls. They do not spend Google quota. Separate live checks on 2026-10-08 with `gemini-3.7-flash` confirmed two-turn memory and automatic recovery from a rejected reference on both providers using synthetic local history. Cloud rejected `minimal` thinking for this model; model default worked. Account-specific tool/model combinations still depend on provider support.

## Official references (reviewed 2026-10-08)

- [Interactions overview and state management](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Stable API reference](https://ai.google.dev/api/interactions-api-v1)
- [Stable OpenAPI contract](https://ai.google.dev/static/api/interactions-v1.openapi.json)
- [Beta API reference](https://ai.google.dev/api/interactions-api)
- [Google Cloud authentication and state management](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/interactions/developer-guide)
- [Google Cloud Interactions API reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api)

The stable contract omits temperature and top-P. The beta contract still lists them as deprecated. This implementation follows the version-specific contracts instead of forwarding unsupported controls to v1.
