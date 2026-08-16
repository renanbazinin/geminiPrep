# Vertex AI Context Cache Lab — English Guide

> Reviewed against the Google Cloud documentation on 2026-08-14. Model support, limits, and pricing can change; follow the linked official pages before production use.

## What this lab teaches

Context caching lets repeated requests refer to a previously stored, large input instead of sending that input every time. It is useful when many prompts share the same long document, video, audio file, instructions, or tool declarations.

This lab demonstrates the complete **explicit cache** lifecycle:

1. Create a `CachedContent` resource.
2. Inspect the metadata and server-reported token count.
3. Use its resource name in a generation request.
4. prove the hit with `usageMetadata.cachedContentTokenCount`.
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

The cache lab’s **See implicit cache** action sends four `generateContent` calls: the large document is `systemInstruction`, the two questions alternate, and there is no `cachedContent` resource. Compare the usage objects. The first call often writes the prefix; later calls can show a hit. Gemini 3 often needs a third call.

In chat, open **Debug trace** on the assistant turn. The summary chip reads `implicit · N` on a hit, or `no cache hit` when the field is missing. That last state is a miss, not “cache not requested” — implicit caching is always eligible on supported models.

A miss after a large shared prefix is normal. Implicit caching is best-effort. Send the next turn immediately, keep the shared document first, and stay above the Gemini 3 minimum of 4,096 tokens.

## Gemini 3 series relevance

The default model picker follows the explicit-cache support table from the official overview. At the review date it includes:

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

Collection name:

```text
projects/{project}/locations/{location}/cachedContents
```

Regional REST hostname:

```text
https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/cachedContents
```

Global REST hostname:

```text
https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/cachedContents
```

Generation with the cache uses the selected publisher model’s `:generateContent` endpoint and places the returned cache resource name in the `cachedContent` field.

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

Example with inline text:

```json
{
  "model": "projects/PROJECT/locations/global/publishers/google/models/gemini-3.6-flash",
  "displayName": "policy-learning-cache",
  "systemInstruction": {
    "parts": [{ "text": "Answer only from the cached policy." }]
  },
  "contents": [{
    "role": "user",
    "parts": [{ "text": "A sufficiently long shared document…" }]
  }],
  "ttl": "3600s"
}
```

Example mixing text with files. `parts` is an ordered list, so one cache can hold a study document, an uploaded PDF, and a Cloud Storage object at the same time:

```json
{
  "model": "projects/PROJECT/locations/us-central1/publishers/google/models/gemini-3.6-flash",
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
  "expireTime": "2026-08-14T15:30:00Z"
}
```

`inlineData` carries the file's bytes as base64 inside the request itself; `fileData` carries only a pointer to an object that already lives in Cloud Storage. Both end up as cached tokens, so both count toward the 4,096-token minimum.

## Size and storage rules

- Gemini 3 explicit caches require at least 4,096 input tokens according to the current overview.
- Inline/blob/text cached content is limited to 10 MB.
- Base64 `inlineData` inflates the file by about a third and must fit in one request; the lab caps it at 15 MB per create call.
- Use Cloud Storage for larger content.
- The exact usable media formats and limits also depend on the model.
- A cache belongs to one project and location. Use it through a compatible model endpoint in that location.

## Using the cache and proving a hit

A generation request references the cache by name:

```json
{
  "cachedContent": "projects/PROJECT/locations/global/cachedContents/CACHE_ID",
  "contents": [{
    "role": "user",
    "parts": [{ "text": "How often should cost be reviewed?" }]
  }]
}
```

The lab highlights this response field:

```text
usageMetadata.cachedContentTokenCount
```

A positive cached-token count is the provider’s evidence that cached input was used. Latency alone is not proof: network variance, capacity, output length, and warm infrastructure can all change timing.

Also compare:

- `promptTokenCount`: all input tokens considered by the request.
- `candidatesTokenCount`: output tokens.
- `totalTokenCount`: total usage reported by the provider.
- `thoughtsTokenCount`: Gemini 3 thinking tokens. These are drawn from `maxOutputTokens` but are *not* included in `candidatesTokenCount`, so a reply can stop at `MAX_TOKENS` after only a handful of visible tokens. Add the two together before concluding your budget is large enough, or lower `thinkingLevel`.

## Using the cache from chat

**Settings → Context cache** turns this on for ordinary conversations. When a chat carries files, the app fingerprints the material (model, location, system instruction, and every file) and:

1. reuses a live cache with that fingerprint, or
2. creates one, storing its resource name and `expireTime` in this browser's local registry.

Requests then send `cachedContent` plus the new turn only. The files and the system instruction are deliberately dropped from the request body, because the cache already holds them and Vertex rejects a duplicate system instruction.

Because cached content is immutable, anything that changes the fingerprint — switching model, changing the system instruction, attaching another file — produces a *new* cache. The old one keeps billing until its TTL runs out, so the Settings list shows every live cache with a countdown and a delete button. Entries vanish from the list once they expire, since Vertex has already stopped serving and billing them.

The lab's own generate step and chat share one `thinkingLevel` setting, which is sent as `generationConfig.thinkingConfig.thinkingLevel`.

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

## Suggested experiments

1. Create a one-hour cache from the learning sample and record `totalTokenCount`.
2. Ask two different questions and compare `cachedContentTokenCount` and latency.
3. Extend its TTL, refresh metadata, and watch the countdown change.
4. List resources in the location and inspect the same cache again.
5. Delete it immediately after the experiment.
6. Separately test implicit prefix caching and compare its usage metadata—do not confuse the two mechanisms.

## Official references

- [Context cache overview](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview?hl=en)
- [Create a context cache](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-create?hl=en)
- [Use a context cache](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-use?hl=en)
- [Update a context cache](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-update?hl=en)
- [CachedContents REST resource](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/projects.locations.cachedContents)

