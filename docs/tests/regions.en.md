# Vertex AI Regions Test — English Guide

## Purpose

The Regions test answers one narrow question with evidence: **does a particular Vertex AI publisher model respond from a particular Vertex location?**

It sends a minimal `generateContent` request for every selected model × region pair and classifies the HTTP outcome. It does not benchmark model quality, throughput, or data residency.

## Prerequisites

1. Select a Google Cloud project with the Vertex AI API enabled.
2. Sign in locally with Application Default Credentials:

   ```powershell
   gcloud auth application-default login
   ```

3. Set `GCP_PROJECT` in `.env`. The UI permits a temporary project ID only when the server does not have one configured.
4. Ensure the signed-in principal can invoke publisher models in that project.

The Regions test uses OAuth/ADC. `GEMINI_API_KEY` is unrelated to this test.

## Endpoint shapes

```text
/v1/projects/{project}/locations/{region}/publishers/google/models/{model}:generateContent
```

| Location type | Example hostname |
| --- | --- |
| Global | `aiplatform.googleapis.com` |
| EU multi-region | `aiplatform.eu.rep.googleapis.com` |
| US multi-region | `aiplatform.us.rep.googleapis.com` |
| Single region | `{region}-aiplatform.googleapis.com` |

Each call sends `ping` with temperature `0` and a maximum of 16 output tokens. This keeps the request small while exercising the real content-generation endpoint.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| Available | The endpoint returned HTTP 2xx. |
| Quota hit | HTTP 429; the model is published there, but quota prevented generation. Counted as available. |
| Not served | HTTP 404, or a relevant HTTP 400 message indicating the model is unavailable in the location. |
| Permission denied | HTTP 401 or 403. This does not prove the model is unavailable. |
| Timed out | The request exceeded the configured timeout. A timeout is not treated as unavailability. |
| Error | Transport failure or an unclassified provider error. Transport errors receive one retry. |

Click a matrix cell to inspect its endpoint, status, latency, retry state, and provider message. Use **Copy Markdown** to move a compact matrix into learning notes.

## Configuration

The catalog can be extended through comma-separated environment variables:

- `VERTEX_PROBE_MODELS`
- `VERTEX_PROBE_REGIONS`
- `VERTEX_PROBE_DEFAULT_REGIONS`
- `VERTEX_PROBE_TIMEOUT_MS` (default `30000`)
- `VERTEX_PROBE_CONCURRENCY` (default `8`)

Unknown IDs are retained, so a newly released model or location can be tested without changing application code.

## Limitations

- A result is a point-in-time observation for one project and identity.
- Model catalogs and serving locations change.
- IAM, organization policy, VPC Service Controls, capacity, and quota can affect outcomes.
- The matrix fans out real generation calls and can consume quota.
- Latency is diagnostic, not a controlled benchmark.
- The Gemini Developer API uses a global endpoint and is outside this test.

## Learning note

Keep these outcomes separate: published and callable, published but blocked by quota or permissions, and not published in the location. A single pass/fail result hides whether the problem is topology, credentials, or capacity.

