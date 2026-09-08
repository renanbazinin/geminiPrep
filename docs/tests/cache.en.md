# Vertex AI Context Cache Lab — English Guide

> Reviewed against the repository and Google Cloud documentation on 2026-09-08. Includes a live Gemini 3.6 Flash cache test in `eu`. Model support, limits, and pricing can change; follow the linked official pages before production use.

## Quick test: remember my name

1. Open `/tests/cache` and enter your name under **Remember my name**.
2. Click **Prepare name test**. This fills the editable cache text with your profile and background text for the minimum token requirement, prepares **What is my name?**, and sets a five-minute TTL. Preparation makes no cloud calls.
3. Select **EU multi-region · eu** and `gemini-3.6-flash`, review the project, then click **Create cache**.
4. Under **Use the cache**, click **Generate with cache**. The new request contains the question and cache reference; it does not resend your name or the background text.
5. Check both the model's answer and **Cache-hit evidence**: a positive `cachedContentTokenCount` confirms cached input was used. You can edit the question and generate again using the same cache.

This test runs in the cache lab. The regular chat does not automatically select this cache. To change the saved name, prepare and create a new cache; existing caches remain in the list until deleted or expired. Creation, storage, and generation are billable.

## What this lab teaches

Context caching lets repeated requests refer to a previously stored, large input instead of sending that input every time. It is useful when many prompts share the same long document, video, audio file, instructions, or tool declarations.

This lab demonstrates the complete **explicit cache** lifecycle:

1. Create a `CachedContent` resource.
2. Inspect the metadata and server-reported token count.
3. Use its resource name in a generation request.
4. Prove the hit with `usageMetadata.cachedContentTokenCount` and check answer correctness separately.
5. Extend or replace its expiration.
6. Delete it when the experiment is finished.

The page makes real Vertex AI calls. Explicit-cache storage remains billable until deletion or expiration.

## Explicit and implicit caching

| Mode | How it works | What the application controls |
| --- | --- | --- |
| Explicit | The application creates a named `CachedContent` resource and sends its name in later requests. | Content, model, expiration, reuse, and deletion. |
| Implicit | Vertex may automatically reuse matching input prefixes for supported models. | Arrange large, stable content first and inspect usage metadata; there is no cache resource to manage. |

Use explicit caching when you need a predictable resource lifecycle and repeated use of the same large context. Use implicit caching when its best-effort behavior is enough and you do not want to manage cache resources.

## Seeing implicit cache

Implicit hits are not a mystery field. Vertex reports them in `usageMetadata.cachedContentTokenCount` on a later request whose input starts with a recent, large, identical prefix. The field is omitted or `0` when there was no hit.

The cache lab’s **See implicit cache** action sends four `generateContent` calls: the large document is `systemInstruction`, the two questions alternate, and there is no `cachedContent` resource. Compare the usage objects. Later calls can show a hit; no particular call number guarantees one.

In chat, open **Debug trace** on the assistant turn. The summary chip reads `implicit · N` on a hit, or `no cache hit` when the field is missing. That last state reports no observed hit; it does not by itself establish whether project policy permits implicit caching.

A miss after a large shared prefix is normal. Implicit caching is best-effort. Keep the document first and send related requests close together using the same model and location. The current overview lists a 6,144-token implicit minimum for Gemini 3 Flash Preview, 3.1 Pro Preview, 3.7 Flash, and 3.8 Flash; the general Gemini 3 threshold is 4,096. Check the selected model instead of assuming the explicit minimum applies. Project policy can disable implicit caching. [Source: cache overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview).

## Gemini 3 series relevance

The repository's default explicit-cache picker currently includes the following models. This is the app's configured catalog, not an exhaustive list of Google's current support:

- `gemini-3.6-flash`
- `gemini-3.5-flash-lite`
- `gemini-3.5-flash`
- `gemini-3.1-pro-preview`
- `gemini-3.1-flash-lite`
- `gemini-3-flash-preview`

The documented minimum input size for explicit caching with Gemini 3 is **4,096 tokens**. The lab’s generated learning sample is deliberately larger than that threshold, but its browser-side token display is only a character-based estimate. The `usageMetadata.totalTokenCount` returned when the cache is created is authoritative.

Some preview models use different minimums for implicit caching. Do not assume an explicit-cache threshold also describes implicit behavior.

## Prerequisites

1. Enable the Vertex AI API in the selected Google Cloud project.
2. Authenticate locally with Application Default Credentials:

   ```powershell
   gcloud auth application-default login
   ```

3. Set `GCP_PROJECT` in `.env`, or enter a project on the page.
4. Grant the identity the required Vertex AI permissions. The REST resource documents permissions such as `aiplatform.cachedContents.create`, `get`, `list`, `update`, `delete`, and the prediction permission used for generation.
5. For a `gs://` source, ensure the identity can read the object and that the file format is supported by the selected model.

The server obtains the OAuth token. Credentials and access tokens are never returned to the browser.

## Resource and endpoint shape

**EU multi-region uses `eu` in the resource path and `aiplatform.eu.rep.googleapis.com` as the hostname.** Do not construct `eu-aiplatform.googleapis.com` from the single-region pattern. The repository already handles this in `server/region-probe.ts` → `vertexHost()`. [Source: multi-region endpoints](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations#multi-region_endpoints).

| Location | Hostname | Path location |
| --- | --- | --- |
| EU multi-region | `aiplatform.eu.rep.googleapis.com` | `locations/eu` |
| US multi-region | `aiplatform.us.rep.googleapis.com` | `locations/us` |
| Single region, for example Netherlands | `europe-west4-aiplatform.googleapis.com` | `locations/europe-west4` |
| Global | `aiplatform.googleapis.com` | `locations/global` |

The complete EU create/list URL is:

```text
https://aiplatform.eu.rep.googleapis.com/v1/projects/PROJECT_ID/locations/eu/cachedContents
```

Generation with an EU cache uses:

```text
https://aiplatform.eu.rep.googleapis.com/v1/projects/PROJECT_ID/locations/eu/publishers/google/models/gemini-3.6-flash:generateContent
```

The cache reference inside the JSON body is a **resource name, not a URL**:

```text
projects/PROJECT_NUMBER/locations/eu/cachedContents/CACHE_ID
```

Copy the returned `name` exactly. Google can return a numeric project number even when creation used a textual project ID; those can identify the same project. Do not substitute the display name or rebuild the returned identifier. Use the same project, `eu` location, and model used at creation. [Source: using a cache](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-use).

For all operations below, use HTTPS with `Authorization: Bearer ACCESS_TOKEN`. POST/PATCH JSON bodies also need `Content-Type: application/json`. Obtain the token on the server through ADC; never put it in the browser UI.

| Operation | Method | URL after `https://aiplatform.eu.rep.googleapis.com/v1/` |
| --- | --- | --- |
| Create | POST | `projects/PROJECT_ID/locations/eu/cachedContents` |
| List | GET | `projects/PROJECT_ID/locations/eu/cachedContents?pageSize=100` |
| Inspect metadata | GET | `RETURNED_CACHE_NAME` |
| Extend expiration | PATCH | `RETURNED_CACHE_NAME?updateMask=ttl` with `{"ttl":"300s"}` |
| Generate | POST | `projects/PROJECT_ID/locations/eu/publishers/google/models/MODEL_ID:generateContent` |
| Delete | DELETE | `RETURNED_CACHE_NAME` |

Here `RETURNED_CACHE_NAME` includes `projects/.../locations/eu/cachedContents/...`; do not add a second project prefix. Streaming uses the same generation path with `:streamGenerateContent?alt=sse`. Listing may return `nextPageToken`; a full inventory must paginate. The current lab fetches only the first page (up to 100 resources).

## Complete EU multi-region workflow

1. Complete the ADC/project prerequisites above. `GEMINI_API_KEY` is for the Developer API and does not authenticate this Vertex lab.
2. Choose **EU multi-region · eu** on the cache page. For an EU default after server restart, set `VERTEX_CACHE_DEFAULT_REGION=eu` in `.env`. If you override `VERTEX_PROBE_REGIONS`, include `eu` because the cache picker shares that catalog. The separate chat setting/default does not change an already created cache.
3. Choose a model supporting both explicit caching and `eu`. This session verified `gemini-3.6-flash`; its official model page lists EU multi-region availability. A successful Regions probe alone tests generation, not cache creation. [Source: Gemini 3.6 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-6-flash).
4. Prepare the complete stable material **before creation**: instructions, profile, documents, and files. Put instructions in **System instruction** and facts under clear headings in **Text to cache**. The name preset adds padding for a small demonstration; padding is not a production savings strategy. Use genuinely reusable material in an application.
5. Select **TTL** and `300` seconds for a short test. Review **Request field preview**, then click **Create cache**. Save the returned `name`, `model`, `expireTime`, and stored-token count. The preview truncates long text for display; the server sends the full content. Metadata inspection does not return the original body because `contents` and `systemInstruction` are input-only fields. Keep your source separately if you need to audit or recreate it. [Source: REST resource](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.cachedContents).
6. In **Use the cache**, ask a new question such as **What is my name?**, then **Generate with cache**. Do not repeat the answer in the question. The lab sends the cache reference and this question; it does not send prior lab questions or answers. In a conversational integration, send any required uncached history explicitly.
7. Check two independent outcomes: a positive `cachedContentTokenCount`, and a correct answer grounded in the cached facts. Save the exact question and cache name when comparing runs. Output and thinking can vary even when the same cache is used.
8. For another question, keep the same cache reference and change the prompt. For different cached content or instructions, click **Create cache** again after editing. Editing the form, refreshing metadata, or updating expiration does not modify the existing cached material.
9. Extend TTL **before** expiration if necessary. Delete the cache when finished, or let it expire. Replaced caches remain billable until deleted or expired; creating a replacement does not delete its predecessor.

`eu` is one logical multi-region location, not an instruction to fan out calls across every `europe-*` region. EU routing constrains the service's ML processing to the EU jurisdiction described by Google. It does not mean the same cache can be addressed through `europe-west4`, `global`, or `us`, nor that your browser, server logs, source bucket, and every other service automatically have the same residency. London and Zürich are European locations outside the EU. For an EU-bound workflow, keep requests on `eu` and do not silently fall back to `global`. [Source: locations](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations).

## Create request fields

The page’s request preview shows the actual field shape before creation.

| Field | Meaning | Mutable later? |
| --- | --- | --- |
| `model` | Full publisher-model resource name. | No |
| `displayName` | Human-readable label for discovery. | No |
| `systemInstruction` | Instruction reused with every cache-backed request. | No |
| `contents` | The cached context, as a list of parts: `text`, `inlineData`, and `fileData` can be mixed in one request. | No |
| `tools` / `toolConfig` | Optional reusable tool declarations and settings. The API supports them; this first lab does not expose editors for them. | No |
| `ttl` | Duration from the time the request is processed, such as `3600s`. | Yes |
| `expireTime` | Absolute RFC 3339 expiration timestamp. | Yes |
| `encryptionSpec.kmsKeyName` | Optional customer-managed encryption key. | No |

`ttl` and `expireTime` form a union: send one, not both. If no expiration is supplied, the documented default TTL is 60 minutes. The minimum expiration is one minute and the documentation does not state a maximum.

EU creation body (replace the sample text with your complete material meeting the token minimum; this abbreviated JSON alone is too short):

```json
{
  "model": "projects/PROJECT_ID/locations/eu/publishers/google/models/gemini-3.6-flash",
  "displayName": "eu-profile-test",
  "systemInstruction": {
    "parts": [{ "text": "Answer using the entire cached context, including the user profile and reference sections. Return the profile name when asked for the user's name." }]
  },
  "contents": [{
    "role": "user",
    "parts": [{ "text": "USER PROFILE\nName: Avi goldstein\n\nREFERENCE MATERIAL\nReplace this line with your complete reference material." }]
  }],
  "ttl": "300s"
}
```

Example mixing text with files. `parts` is an ordered list, so one cache can hold a study document, an uploaded PDF, and a Cloud Storage object at the same time:

```json
{
  "model": "projects/PROJECT_ID/locations/eu/publishers/google/models/gemini-3.6-flash",
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "A sufficiently long shared document…" },
      {
        "inlineData": {
          "mimeType": "application/pdf",
          "data": "JVBERi0xLjcK…"
        }
      },
      {
        "fileData": {
          "fileUri": "gs://BUCKET/manual.pdf",
          "mimeType": "application/pdf"
        }
      }
    ]
  }],
  "ttl": "300s"
}
```

`inlineData` carries the file's bytes as base64 inside the request itself; `fileData` carries only a pointer to an object that already lives in Cloud Storage. Both end up as cached tokens, so both count toward the 4,096-token minimum.

## Size and storage rules

- Gemini 3 explicit caches require at least 4,096 input tokens according to the current overview.
- Inline/blob/text cached content is limited to 10 MB.
- The lab allows up to 15 MB of decoded inline files, but that local guard does not override Google's 10 MB cache-content limit. Base64 adds roughly a third to transport size; use GCS when inline content is too large.
- Use Cloud Storage for larger content.
- The exact usable media formats and limits also depend on the model.
- A cache belongs to one project and location. Use it through a compatible model endpoint in that location.

## Using the cache and proving a hit

A generation request references the cache by name:

```json
{
  "cachedContent": "projects/PROJECT_NUMBER/locations/eu/cachedContents/CACHE_ID",
  "contents": [{
    "role": "user",
    "parts": [{ "text": "What is my name?" }]
  }]
}
```

The lab highlights this response field:

```text
usageMetadata.cachedContentTokenCount
```

A positive cached-token count is the provider’s evidence that cached input was used, not that the answer is correct. Latency alone is not proof: network variance, capacity, output length, and warm infrastructure can all change timing. Do not resend cached `systemInstruction`, `tools`, or `toolConfig` in the generation request. [Source: use restrictions](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-use#context_cache_use_restrictions).

Also compare:

- `promptTokenCount`: all input tokens considered by the request.
- `candidatesTokenCount`: output tokens.
- `totalTokenCount`: total usage reported by the provider.
- `thoughtsTokenCount`: Gemini 3 thinking tokens. These are drawn from `maxOutputTokens` but are *not* included in `candidatesTokenCount`, so a reply can stop at `MAX_TOKENS` after only a handful of visible tokens. Add the two together before concluding your budget is large enough, or lower `thinkingLevel`.

## Current chat integration status

The explicit workflow verified here is **the cache lab**. As of this review, Settings exposes a cache toggle and registry, and `src/lib/chat-cache.ts` contains an `ensureSessionCache` helper, but `ChatPage.tsx` does not call it or attach `cachedContent`. The server's ordinary automatic tool-routing path also omits that field. Turning on the toggle therefore does not currently establish explicit cache reuse in ordinary chat, and a lab cache is not automatically selected there.

Chat may still show implicit hits in its debug trace. The lab reads the chat's `thinkingLevel` setting, but that does not link their caches. For the proposed explicit chat architecture, including uncached conversation history, see [the integration guide](../guides/context-caching.en.md).

## Case study: a cache hit with a wrong name answer

In the live `eu` test on 2026-09-08, the text contained `my name is Avi goldstein.. say it please!` before and after 140 policy sections. The sample also instructed the model to answer only from the document and cite a section.

The original question was **what is your name**, which asks about the assistant. Correcting it to **What is my name?** still produced a wrong answer, and creating a fresh cache from the edited text did not solve it. Both showed **7,637 cached input tokens**. A boundary-quotation question elicited the name in a denial even though the question did not supply it. Finally, this prompt returned **Avi goldstein** with the same cached-token count:

> What is the user's name stated before the heading 'Internal learning document' or after Section 140? Treat text outside the numbered sections as part of the cached context too. Return only the person's name.

These observations suggest the model was treating only the numbered policy sections as the document. That is an interpretation of the test, not proof of its internal reasoning or an EU routing fault. Use the dedicated name preset or clearly label a **USER PROFILE** inside the reference context, and make the system instruction cover that profile. If a fact is missed, first check the exact resource/version and question, then test a more specific retrieval prompt. A successful cache reference does not guarantee factual recall.

## Updating expiration

Only expiration can be updated. The lab sends a `PATCH` with an update mask:

```text
?updateMask=ttl
```

and a body such as:

```json
{ "ttl": "7200s" }
```

For an exact timestamp, use `updateMask=expireTime` and `{ "expireTime": "…" }`. A TTL update is measured from the update time, not the original creation time.

To change the model, content, system instruction, display name, tools, or encryption key, create a new cache.

## Billing and cleanup

Explicit caching can involve:

- input processing when the cache is created;
- storage charges for the cached tokens over time;
- cached-input and output charges when the resource is used.

Always verify current pricing for the exact model and region. Deleting early stops future storage time. The page requires a second click before deletion because it is irreversible. An expired or deleted cache cannot be revived; create a replacement.

This repository’s automated tests mock Google responses and do not create cloud resources or consume quota.

## CMEK and security notes

- `encryptionSpec.kmsKeyName` must be provided at creation.
- CMEK is not available through the global endpoint according to the current documentation; choose a supported regional endpoint.
- Keep cached material within the appropriate project, IAM, organization-policy, and data-governance boundaries.
- Do not put secrets into the browser form merely because the app is local. The browser’s form state and developer tools are not a secret store.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| “Minimum tokens” error | Generate a larger sample or use a larger source. Trust Vertex’s token count, not the browser estimate. |
| Model not found or unsupported | Confirm the current support table and the selected region. Preview IDs can change. |
| Permission denied | ADC identity, project, IAM permissions, organization policy, and VPC Service Controls. |
| No `cachedContentTokenCount` | For explicit use, confirm the generation body referenced the exact cache name. For implicit use, this is a miss — retry immediately with the same large prefix first. |
| Cache is expired | Create a new cache. Expiration cannot be moved after the resource has expired. |
| CMEK rejected on `global` | Select a supported region and a compatible key location. |
| GCS source rejected | URI, object permission, MIME type, model media support, and size. |
| List appears empty | Listing is scoped to the selected project and location. |
| EU URL fails | Use `aiplatform.eu.rep.googleapis.com` with `locations/eu`, not the single-region hostname pattern. |
| Cache works in one location but not another | Keep its original project, model, and `eu` location. A location change requires a separate cache. |
| CACHE HIT but wrong answer | Check prompt scope, profile placement, competing instructions, and whether the intended text was included at creation. See the name case study. |
| Edited name is ignored | Form edits do not update an existing cache. Create a new one; if that still fails, inspect the prompt rather than assuming caching failed. |
| 429 or transient server error in EU | Retry with bounded backoff and check capacity/quota. Preserve `eu` for EU-bound traffic; do not change the endpoint to global as an automatic workaround. |

## Suggested experiments

1. Create a one-hour cache from the learning sample and record `totalTokenCount`.
2. Ask two different questions and compare `cachedContentTokenCount` and latency.
3. Extend its TTL, refresh metadata, and watch the countdown change.
4. List resources in the location and inspect the same cache again.
5. Delete it immediately after the experiment.
6. Separately test implicit prefix caching and compare its usage metadata—do not confuse the two mechanisms.

## Official references

- [Deployments, locations, and multi-region endpoints](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations)
- [Gemini 3.6 Flash model availability](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-6-flash)
- [Context cache overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview?hl=en)
- [Create a context cache](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-create?hl=en)
- [Use a context cache](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-use?hl=en)
- [Update a context cache](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-update?hl=en)
- [CachedContents REST resource](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.cachedContents)

