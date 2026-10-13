# Adding Gemini 4 (the Pro toggle)

Google released **Gemini 4 Argon** (`gemini-4-argon`) as generally available on 2026-10-13. It is
Google's flagship reasoning model. This guide explains the **Gemini 4** toggle that switches the chat to
it, what changes in the API compared with Gemini 3.x, and how it was added and verified.

## Using it

- **Chat:** the **Gemini 4 · Pro** switch in the top bar. On, every new turn uses `gemini-4-argon`. Off, chat
  returns to the model chosen in Settings. The toggle never overwrites that choice.
- **Settings → Model configuration:** the same setting appears as **Use Gemini 4 (Pro model)**. While it is
  on, the model menu is locked and the controls Gemini 4 ignores are disabled with an explanation.
- The choice is saved in the browser and survives reloads.
- It works with both providers (Gemini Developer API and Vertex AI) and both API modes (Interactions and
  Generate Content).
- Switching models starts a fresh stored conversation built from local history. This is the same rule
  as any other model change. Each model then continues its own chain.
- If the server does not offer the model, the switch is disabled, and a saved "on" turns itself off.

## Same or more complex?

**For everyday chat it is the same API, with fewer settings.** The request shape, the streaming events,
`previous_interaction_id` and tools all stay as they were. Gemini 4 removes some settings rather than
adding any:

| Area | Gemini 3.x | Gemini 4 | What the app does |
| --- | --- | --- | --- |
| Sampling | `temperature`, `top_p` honoured | Ignored | Does not send them; the sliders are disabled |
| Thinking levels | `minimal`, `low`, `medium`, `high` | `low`, `medium` (default), `high`; `minimal` returns HTTP 400 | Sends `minimal` as `low`; the option is disabled |
| Output budget | Thinking shares `max_output_tokens` | Same, but thinks more | Raises the limit to at least 32,768 (larger values are kept) |
| Explicit cache (`cachedContents`) | Supported | Not supported; implicit caching only | Rejects `cachedContent` before calling Google |
| Vertex locations | Many single regions | `global`, `us`, `eu` only | Rejects other regions before calling Google, with a clear message |
| Free tier | Available | Paid tier only | Google's error is shown as-is |

**Long decode is the one genuinely harder feature.** It covers answers longer than about 64K tokens, up
to 1,048,576, and the two providers do it differently:

- **Gemini Developer API:** Interactions with `background: true`, then fetching the result instead of
  streaming it, and joining the text of several `model_output` steps.
- **Vertex AI:** only Generate Content on the `v1beta1` endpoint supports it, and Vertex Interactions does
  not. The client keeps resending the request with `continuation_token` until `finish_reason=STOP`. Each
  request has a 20-minute limit.

The app does not implement long decode. Its output limit stays at 65,536 tokens.

## Where it runs

| Provider | Endpoint | Notes |
| --- | --- | --- |
| Gemini Developer API | Global | Paid API key required |
| Vertex · Interactions | `global` | The app always uses global for Interactions |
| Vertex · Generate Content | `global`, `us` (`aiplatform.us.rep…`), `eu` (`aiplatform.eu.rep…`) | Single regions such as `europe-west1` are not served |

**EU data processing:** Google lists ML processing for Gemini 4 only in the `us` and `eu` multi-regions,
not on `global`. To keep processing in the EU, use **Vertex · Generate Content** with the **EU multi-region**.
Interactions in this app always runs on `global`.

**Pricing** (Gemini Developer API, per 1M tokens): $2 input and $10 output, including thinking, until
2026-11-30. From 2026-12-01 it is $4 / $20. Cached input is $0.10, then $0.20.

## How it was added

1. **One shared module of rules**, [`shared/gemini-4.ts`](../../shared/gemini-4.ts). It holds the model
   (`PRO_MODEL`), the display label, the allowed Vertex regions, the minimum output budget, and small
   helpers. `isGemini4Model()` matches the `gemini-4` prefix, so future Gemini 4 variants get the same
   rules.
2. **Catalog**, [`server/catalog.ts`](../../server/catalog.ts). The Pro model is appended to both chat
   model lists, even when `GEMINI_CHAT_MODELS` or `VERTEX_CHAT_MODELS` narrows them, so the toggle always
   works. Being last keeps it from becoming the default for fresh settings. It also joins the region lab.
3. **Validation**, [`server/chat/validation.ts`](../../server/chat/validation.ts). It rejects an
   unsupported Vertex region and an explicit cache before any Google call.
4. **Request builders**, [`server/chat/interactions.ts`](../../server/chat/interactions.ts) and
   [`server/chat/upstream.ts`](../../server/chat/upstream.ts). For Gemini 4 they drop sampling, map
   `minimal` to `low`, and raise a small output limit. Image hand-offs still use the image model with its
   own settings.
5. **Browser.** A `proModel` setting ([`src/lib/storage.ts`](../../src/lib/storage.ts)) and the switch
   ([`src/components/ProModelToggle.tsx`](../../src/components/ProModelToggle.tsx)). `chatModelFor()`
   picks the model for each turn and for conversation-chain matching.

To move the toggle to a later Pro model, change `PRO_MODEL` and `PRO_MODEL_LABEL`, then review the rules in
the same file.

## A bug found while testing

The first live run failed on a **Vertex Interactions follow-up sent right after the first turn**. Google
replied *"Previous interaction … is in an invalid state (current state: IN_PROGRESS)"*. The cause was in
the app, not Gemini 4. The proxy cancelled Google's stream as soon as it saw `interaction.completed`, and
Vertex finishes storing the turn only when its stream closes normally:

| How the first stream ended | Instant follow-up (3.8 Flash and Gemini 4) |
| --- | --- |
| Cancelled at `interaction.completed` (old code) | Failed 6 of 6 |
| Read to its natural end | Succeeded 3 of 3 |

The proxy now reads the stream to its end and ignores anything after completion. A regression test
covers this. In the browser, a fast typist or a quick second message could hit the old bug with any
model.

## Verification

Automated tests, with mocked Google responses and no quota spent:

- [`server/chat/gemini-4.test.ts`](../../server/chat/gemini-4.test.ts) runs every chat request path: the
  Gemini API with Interactions v1 and v1beta and with Generate Content, then Vertex with Interactions and
  with Generate Content on `global`, `eu` and `us`. Each path checks the URL, the model, the omitted
  sampling, the output budget, the streamed text, and that no credentials leak. Further tests cover
  stateful follow-ups, image hand-off, thinking-level mapping, rejected regions and caches, free-tier
  errors, and that other models are unchanged.
- [`src/components/ProModelToggle.test.tsx`](../../src/components/ProModelToggle.test.tsx) covers the
  toggle in chat and Settings: switching back and forth, separate conversation chains, reloads, a server
  without the model, region warnings, disabled controls, and older saved settings.
- [`server/chat/vertex-interactions.test.ts`](../../server/chat/vertex-interactions.test.ts) holds the
  stream-drain regression test.

A live check sends real, billable requests (a few words each, low thinking) through the app's own
`/api/chat/stream`:

```bash
npm run check:gemini-4
```

Pass `-- gemini` or `-- vertex` to check one provider. Results on 2026-10-13, all passing:

| Path | Result |
| --- | --- |
| Gemini API · Interactions v1, new conversation and follow-up | Passed; the follow-up recalled the first turn |
| Gemini API · Interactions v1beta with `minimal` thinking and Top P | Passed, sent as `low` with Top P dropped |
| Gemini API · Interactions v1 with a JSON schema | Passed, `{"sum": 5}` |
| Gemini API · Generate Content | Passed |
| Vertex · Interactions (global), new conversation and follow-up | Passed after the drain fix |
| Vertex · Generate Content on `global`, `eu`, `us` | Passed |
| Vertex · Generate Content on `europe-west1` | Rejected locally, as intended |

A manual check in the browser, with the toggle on, got back *"I am Gemini 4 Argon … 17 multiplied by 23
is 391"*. The provider request carried `max_output_tokens: 32768` and no temperature.

## Not covered yet

- Long decode (above 64K output tokens), described above
- Gemini 4 Argon Cyber Permissive (`gemini-4-argon-cyber-permissive`), which is allowlist-only
- Computer use (in preview on Gemini 4) and the Live API (not supported)

## Official references (reviewed 2026-10-13)

- [Gemini 4 Argon model page](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)
- [What's new and migration (latest model)](https://ai.google.dev/gemini-api/docs/latest-model)
- [Gemini API changelog](https://ai.google.dev/gemini-api/docs/changelog)
- [Vertex developer's guide to Gemini 4 Argon](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon)
- [Vertex Gemini 4 Argon model reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon)
- [Get started with Gemini 4 on Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/get-started-with-gemini-4)
