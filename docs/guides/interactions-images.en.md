# Images in the Interactions API

Reviewed and checked live on **2026-11-01**. This guide separates Google's published contract,
the behavior observed with the configured credentials, and the features exposed by Gemini Prep.
`v1beta` is the Gemini Developer API version; `v1beta1` is the separate Vertex/Cloud preview version.

## Does it work?

**Yes on the Developer API, including both `v1` and `v1beta`.** With `gemini-3.1-flash-image`,
generation and a stored-interaction follow-up edit returned inline PNGs at `1K`, `16:9`.
Inline PNG understanding with `gemini-3.8-flash` also passed on both versions and on Vertex.

**Vertex image generation through this app's Interactions path failed.** The global `v1beta1`
endpoint returned HTTP 400: `Model 'gemini-3.1-flash-image' is not supported by the Interactions API.`
This is an observed model/endpoint restriction, not evidence that image input is unsupported.
No claim is made that every Cloud project or future model has the same restriction.

| Path | Image input → text | Text → image / follow-up image edit | Location |
| --- | --- | --- | --- |
| Developer `v1` | Passed live | Passed live after the delivery fix below | Global service; no region parameter |
| Developer `v1beta` | Passed live | Passed live after the delivery fix below | Same global service |
| Vertex `v1beta1` | Passed live | Pinned image model rejected; edit was not attempted | App uses `global` |
| Generate Content | Separate existing app path | Possible alternative; not live-tested in this investigation | App pins its image tool to `global` |

The Developer [stable](https://ai.google.dev/api/interactions-api-v1) and
[beta](https://ai.google.dev/api/interactions-api) references both describe multimodal Interactions.
Support still depends on the chosen model, account access, and request fields.

### A schema option that failed live: `delivery`

The old adapter explicitly sent `delivery: "inline"`. Both Developer versions rejected it with
HTTP 400: `Image delivery mode is not supported.` Omitting the property returned inline PNG data.
The adapter now omits it, and a regression test covers both versions. Changing to beta alone
would not have fixed the old request.

Although the published image output schema lists `inline` and `uri`, those enum values do not
prove backend support for this model. URI output was not live-tested, and the app only consumes
inline image data. Read the returned `mime_type`; do not assume an image is JPEG or PNG.

## Using images in this app

1. Select **Gemini Developer API**, then **Settings → Conversation API → Interactions**.
2. Choose `v1` or `v1beta`; stable `v1` is sufficient for the verified workflow.
3. Set **Image aspect ratio** and **Image size**. The saved defaults are `1:1` and `1K`.
4. Open the composer's tool menu and select **Generate image**. Describe the image and send.
5. To edit it, keep **Generate image** selected and send the change, such as “Make the cup blue.”
   Stored, stateful mode can continue the preceding successful image interaction.
6. Download the returned image from its image card.

The image action pins the model to `gemini-3.1-flash-image`, including when the Pro toggle or
another chat model is selected. An ordinary text message does not automatically hand off to the
image model in Interactions mode. That automatic handoff belongs to Generate Content mode.

**Uploading a local photo is not implemented in the composer.** Its picker accepts documents,
not PNG/JPEG/WebP/GIF. The server accepts inline image parts, and generated images are replayed
from local storage, but neither feature adds a photo-upload control. Native PDF visual input is
supported; DOCX/PPTX processing extracts text and does not preserve their embedded pictures.

## Endpoint, version, authentication, and region

| Provider | POST endpoint | Authentication |
| --- | --- | --- |
| Developer stable | `https://generativelanguage.googleapis.com/v1/interactions` | Server-side `x-goog-api-key` |
| Developer beta | `https://generativelanguage.googleapis.com/v1beta/interactions` | Same API key mechanism |
| Vertex preview | `https://aiplatform.googleapis.com/v1beta1/projects/PROJECT_ID/locations/global/interactions` | ADC/service-account OAuth bearer token |

Developer API has no Vertex-style location selector. A saved `europe-west1`, `eu`, or other
Vertex region does not place Developer API requests in that location.

For Cloud, the current [Interactions overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/interactions/)
documents `global`, plus `us`/`eu` multi-regions when using CMEK and serving profiles scoped to
`INTERACTIONS_API`. It also explicitly makes no data-residency commitment for preview session
storage. A multi-region endpoint should not be treated as a blanket session-residency guarantee.

Gemini Prep implements only `global` for Vertex Interactions. The browser sends `global`, the
validator rejects other locations, and the proxy constructs a global URL. No CMEK/serving-profile
configuration is wired into this path. Changing the normal region setting therefore cannot enable
`eu`, `us`, `us-central1`, `europe-west1`, or `me-west1` for Interactions. Neither the regions lab
nor Generate Content model availability proves Interactions availability. Changing a region also
does not establish that the rejected image model becomes supported.

## Image input: understanding, reference images, and editing

Use typed steps for portable requests. The following is a provider request body, not the local
`/api/chat/stream` contract. Replace the placeholder with plain base64 bytes, without a `data:` prefix:

```json
{
  "model": "gemini-3.8-flash",
  "input": [{
    "type": "user_input",
    "content": [
      { "type": "text", "text": "Describe this image." },
      { "type": "image", "mime_type": "image/png", "data": "BASE64_IMAGE_BYTES" }
    ]
  }],
  "store": false
}
```

For reference-based generation or editing, use an image-capable generation model, describe the
desired changes, and request image output. Multiple image content blocks supply multiple references;
label their purpose in the prompt. This is different from Google Image Search grounding.

| Input choice | Published API option | Gemini Prep behavior |
| --- | --- | --- |
| Image bytes | `type: "image"`, `data`, `mime_type` | Inline base64 on both providers; live PNG input passed |
| Image URI | `uri` instead of inline bytes | Not exposed by the local chat contract; Files API/cloud URI access and expiry need separate validation |
| Input MIME type | PNG, JPEG, WebP, HEIC, HEIF, GIF, BMP, TIFF in the image schema | Server accepts PNG/JPEG/WebP/GIF, plus `image/jpg` normalized to JPEG; only PNG was live-tested |
| Input resolution | `resolution`: `low`, `medium`, `high`, `ultra_high` | Not exposed or forwarded; distinct from output `image_size` |
| Local photo picker | Application feature, not an API field | Not implemented |

The input/output field inventory is defined in the official
[stable OpenAPI](https://ai.google.dev/static/api/interactions-v1.openapi.json) and
[beta OpenAPI](https://ai.google.dev/static/api/interactions.openapi.json).
Schema acceptance does not establish that every listed format works with every model.

App limits are separate from Google's model limits: 10 file parts per message, 30 per request,
28,000,000 inline-base64 characters across the request, 200 history messages, and a 30 MB JSON
body limit. The document picker separately limits local selections to 10 files / 20 MB combined.
Replaying many generated images can hit the request limits even if each original turn was small.

## Image output: all exposed options

The app exposes these same enum choices on all three Interactions paths:

| Control | Exact values | Default |
| --- | --- | --- |
| Aspect ratio | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, `1:8`, `8:1`, `1:4`, `4:1` | `1:1` |
| Image size | `512`, `1K`, `2K`, `4K` | `1K` |

Use uppercase `K`. These are output size classes; aspect ratio determines the actual dimensions.
All **168 mappings** (14 ratios × 4 sizes × 3 API paths) were validated locally. Only `1K`/`16:9`
generation was tested live; neither local validation nor the enum list certifies all 56 combinations
for a particular model. In particular, the Cloud mapping does not overcome the observed model rejection.

The [image generation guide](https://ai.google.dev/gemini-api/docs/image-generation) distinguishes
model capabilities: the app's `gemini-3.1-flash-image` supports 512/1K/2K/4K, Flash-Lite Image is
limited to 1K, and Nano Banana 2.1 does not support 512. Pro Image is another separate model.
These models are not interchangeable selections in the app's image action, which remains pinned.
Google also documents image search grounding, reference-image generation, thinking controls,
video-to-image on selected models, and SynthID watermarking. Those broader capabilities do not
mean the app exposes their controls or accepts their inputs.

### Developer API output request (`v1` and `v1beta`)

This body uses the verified field placement and deliberately omits `delivery`:

```json
{
  "model": "gemini-3.1-flash-image",
  "input": [{ "type": "user_input", "content": [
    { "type": "text", "text": "Create an original watercolor of a cup beside a pear." }
  ] }],
  "response_format": [
    { "type": "text" },
    { "type": "image", "aspect_ratio": "16:9", "image_size": "1K" }
  ],
  "generation_config": { "max_output_tokens": 8192 },
  "store": true,
  "stream": true
}
```

The Developer schema also lists output `mime_type: "image/jpeg"`; the app leaves MIME selection
to the provider. Image-only response formats are documented, but the app always requests text
plus image. There is no image-count, JPEG-quality, output-file-format, negative-prompt, mask,
watermark-removal, or transparent-background setting in this adapter.

### Vertex output mapping (model support must be established separately)

The adapter uses Cloud's separate fields, described in the
[Cloud Interactions reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/interactions-api):

```json
{
  "response_modalities": ["text", "image"],
  "generation_config": {
    "max_output_tokens": 8192,
    "image_config": { "aspect_ratio": "16:9", "image_size": "1K" }
  }
}
```

This is a mapping fragment, not a working standalone request. It does not resolve the live
`gemini-3.1-flash-image` rejection. Image request fields in the shared Cloud schema do not certify
image generation for every model. The app does not automatically switch providers, models, or APIs.

## What happens to the other settings?

| Setting | Image generation request in this app |
| --- | --- |
| System instruction | Included when nonempty |
| Maximum output tokens | Included; the live checks used 8192 |
| Seed / stop sequences | Included when set; model support still applies. A stop or small budget can prevent a complete image |
| Temperature / top-P | Omitted on Developer `v1`; forwarded on Developer `v1beta` and Vertex for this image model |
| Thinking level / summaries | Omitted for image generation, even when set for text chat |
| Google Search / URL context / code execution | Omitted for image generation |
| Tool choice | Omitted because no tools are sent on image requests |
| JSON / JSON schema | Replaced by the image output request |
| Store / stateful memory | Used as configured; a continuation requires storage |
| Chat model / Pro toggle | Image action uses the pinned image model |

Image Search is a grounding tool, not a generation model. The Developer schema has
`google_search.search_types` values `web_search` and `image_search`; this app does not expose
that selector and suppresses the whole tools list for image requests. Turning on Google Search
therefore does not ground this app's generated images. Availability of other tools is model-specific.

## Follow-up edits, replay, and storage

After a completed stored image turn, send new input plus `previous_interaction_id`, the same
image model, and the image response preferences again. Do not replay the same old image/history
alongside that continuation ID. The live checks generated an image and immediately requested an
edit through the real local adapter; they confirmed completed IDs and nonempty image payloads,
not visual fidelity of the edits.

Gemini Prep resumes only the latest eligible assistant turn with matching provider, model, API
version, and Cloud project. Switching to normal text chat or changing versions rebuilds from local
history. Returning to the image tool after an intervening text turn also rebuilds if that latest turn
has another model. With storage disabled, every turn sends the local transcript and image bytes.

Generated images live in browser IndexedDB, while transcript metadata lives in localStorage.
Replay attaches those images as `model_output` content. Missing local image bytes stop replay;
the app does not silently omit them. Confirmed expired interaction references trigger one local
history recovery attempt. Provider reasoning and signatures absent from local history cannot be
reconstructed. Clearing local history does not delete Google's stored interactions. Stored state
also does not promise free image context on subsequent turns.

The proxy joins fragmented base64 image deltas and emits images on step completion; it also handles
images present at step start. It accepts PNG/JPEG/WebP/GIF output, not URI-only media. It drains the
stream to its natural end before allowing a continuation, which matters for Vertex stored state.

## Verification and troubleshooting

The investigation used the actual Express `/api/chat/stream` route, validation, request builder,
credentials, and SSE adapter. Inputs were synthetic. Credentials and image payloads were not logged.

| Check on 2026-11-01 | Result |
| --- | --- |
| Original Developer `delivery: "inline"`, both versions | HTTP 400; fixed by omitting the field |
| Developer `v1`, omitted delivery | Image generation and immediate stored follow-up edit passed |
| Developer `v1beta`, omitted delivery | Image generation and immediate stored follow-up edit passed |
| Inline red PNG → color answer, `gemini-3.8-flash` | Passed on Developer v1, Developer v1beta, and Vertex global v1beta1 |
| Vertex image generation, pinned image model | HTTP 400 model not supported; follow-up skipped |
| One earlier beta image attempt | Copyright/recitation rejection even for a simple geometric prompt; a separate original-illustration request completed |
| Every ratio/size mapping | 168 local combinations passed; not an exhaustive paid generation sweep |

The six relevant automated test files passed **95 tests**, including the regression for omitted
delivery on both Developer versions, Cloud mapping, streaming, attachments, and continuation/recovery.
The full `npm run build` stopped at TypeScript errors in pre-existing untracked Jira components,
pages, and tests (missing exports/properties in `shared/jira`); those files were left untouched.

Re-run the reusable check (billable). Default image mode makes up to two calls per API path;
the edit is skipped if generation fails. The full run currently reports the Vertex rejection as
a failure rather than declaring success for the entire matrix. Test interactions use normal
provider storage/retention; the script does not delete them.

```powershell
# Developer generation + stored follow-up edit on both versions
npx tsx scripts/interactions-images-live-check.ts gemini
# Only beta
npx tsx scripts/interactions-images-live-check.ts gemini v1beta
# Cloud generation compatibility check
npx tsx scripts/interactions-images-live-check.ts vertex

# Image understanding on all configured paths (three small requests)
$env:CHECK_IMAGE_INPUT_ONLY = 'true'
npx tsx scripts/interactions-images-live-check.ts
Remove-Item Env:CHECK_IMAGE_INPUT_ONLY

# Select a different output combination; this is another billable run
$env:CHECK_IMAGE_SIZE = '2K'
$env:CHECK_IMAGE_ASPECT_RATIO = '1:1'
npx tsx scripts/interactions-images-live-check.ts gemini v1beta
Remove-Item Env:CHECK_IMAGE_SIZE
Remove-Item Env:CHECK_IMAGE_ASPECT_RATIO
```

The script loads the normal `.env`. Use `GEMINI_API_KEY` for Developer API and the app's configured
Cloud project plus ADC for Vertex. `CHECK_IMAGE_PROMPT` optionally supplies a different generation
prompt. A skipped unconfigured provider is not a successful provider test.

For failures, inspect the provider URL, request fields, error, and terminal event in the local debug
trace. A local HTTP 200 can still contain an SSE error. Do not treat HTTP 200 alone, a stored ID alone,
or a text-only response as successful image generation. An API-version switch cannot fix a rejected
model, disabled billing, missing credentials, quota exhaustion, or a safety refusal. No automatic
generation retries are added for these errors.

Relevant implementation: [request/stream adapter](../../server/chat/interactions.ts),
[validation](../../server/chat/validation.ts), [option enums](../../shared/interactions.ts),
[pinned image model](../../shared/chat-tools.ts), [attachment handling](../../src/lib/attachments.ts),
[local image storage](../../src/lib/generated-images.ts), and
[continuation selection](../../src/lib/interaction-history.ts).
See also the [general Interactions guide](interactions.en.md) and
[migration pitfalls](interactions-migration-pitfalls.en.md).
