# Vertex AI Regions Test

## Purpose

The Regions test answers one narrow question with evidence: **does a particular Vertex AI
publisher model respond from a particular Vertex location?**

The test sends a minimal `generateContent` request for every selected model × region pair and
classifies the HTTP outcome. It does not benchmark model quality, throughput, or data residency.

## Prerequisites

1. Select a Google Cloud project with the Vertex AI API enabled.
2. Sign in locally with Application Default Credentials:

   ```powershell
   gcloud auth application-default login
   ```

3. Set `GCP_PROJECT` in `.env`. The UI permits a temporary project ID only when the server does
   not have one configured.
4. Ensure the signed-in principal can invoke publisher models in that project.

The Regions test uses OAuth/ADC. `GEMINI_API_KEY` is unrelated to this test.

## Endpoint shapes

The resource path is:

```text
/v1/projects/{project}/locations/{region}/publishers/google/models/{model}:generateContent
```

The hostname depends on the selected location:

| Location type | Example hostname |
| --- | --- |
| Global | `aiplatform.googleapis.com` |
| EU multi-region | `aiplatform.eu.rep.googleapis.com` |
| US multi-region | `aiplatform.us.rep.googleapis.com` |
| Single region | `{region}-aiplatform.googleapis.com` |

Each call sends `ping` with temperature `0` and a maximum of 16 output tokens. Flash Image
models also set `responseModalities: ["TEXT", "IMAGE"]` and a higher token cap, because a
text-only request would fail even in a region that serves the model.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| Available | The endpoint returned an HTTP 2xx response. |
| Quota hit | HTTP 429; the model is published there, but quota prevented generation. Counted as available. |
| Not served | HTTP 404, or a relevant HTTP 400 message indicating the model is unavailable in the location. |
| Permission denied | HTTP 401 or 403. This does not prove the model is unavailable. |
| Timed out | The request exceeded the configured timeout. A timeout is not treated as unavailability. |
| Error | Transport failure or an unclassified provider error. Transport errors receive one retry. |

Click a matrix cell to see its exact endpoint, HTTP status, latency, retry state, and provider
message. Use **Copy Markdown** to move a compact availability matrix into learning notes.

## Configuration

The shipped catalog is extensible through comma-separated environment variables:

- `VERTEX_PROBE_MODELS`
- `VERTEX_PROBE_REGIONS`
- `VERTEX_PROBE_DEFAULT_REGIONS`
- `VERTEX_PROBE_TIMEOUT_MS` (default `30000`)
- `VERTEX_PROBE_CONCURRENCY` (default `8`)

Unknown model and region IDs are kept instead of discarded, so a newly released ID can be tested
without changing application code. Unknown region IDs are grouped by their prefix.

## Limitations and interpretation

- A successful result is a point-in-time observation for one project and identity.
- Model catalogs and serving locations change over time.
- IAM, organization policy, VPC Service Controls, capacity, and quota can affect results.
- The matrix fans out real model calls and therefore can consume quota.
- Latency is diagnostic only; this is not a statistically controlled benchmark.
- The Gemini Developer API uses a global endpoint and is intentionally outside this test.

## Learning notes

The important design lesson is to keep three outcomes separate:

1. **Published and callable** — a successful generation.
2. **Published but currently blocked** — quota or permission responses.
3. **Not published in the selected location** — a supported unavailability response.

Collapsing these states into pass/fail hides whether the problem is topology, credentials, or
capacity. The matrix preserves that distinction and exposes the provider evidence for inspection.
