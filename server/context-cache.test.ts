import { describe, expect, it, vi } from "vitest";
import supertest from "supertest";
import type { CacheCreateRequest } from "../shared/contracts.js";
import { createApp } from "./app.js";
import {
  CACHE_MAX_INLINE_BYTES,
  CACHE_MAX_INLINE_FILE_BYTES,
  buildCacheCreateBody,
  cacheCollectionUrl,
  cacheResourceUrl,
  createContextCache,
  deleteContextCache,
  listContextCaches,
  parseCacheName,
  updateContextCacheExpiration,
  useContextCache,
  validateCacheCreateRequest,
} from "./context-cache.js";

const models = ["gemini-3.6-flash"];
const regions = ["global", "eu", "us", "us-central1"];
const resourceName = "projects/study-project/locations/global/cachedContents/cache_123";

function request(overrides: Partial<CacheCreateRequest> = {}): CacheCreateRequest {
  return {
    model: "gemini-3.6-flash",
    region: "global",
    content: "A long learning document",
    expirationMode: "ttl",
    ttlSeconds: 3600,
    ...overrides,
  };
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("context cache URLs", () => {
  it("uses the global hostname for global resources", () => {
    expect(cacheCollectionUrl("study-project", "global")).toBe(
      "https://aiplatform.googleapis.com/v1/projects/study-project/locations/global/cachedContents",
    );
  });

  it("uses representative and regional hostnames", () => {
    expect(cacheCollectionUrl("study-project", "eu")).toContain("aiplatform.eu.rep.googleapis.com");
    expect(cacheCollectionUrl("study-project", "us")).toContain("aiplatform.us.rep.googleapis.com");
    expect(cacheCollectionUrl("study-project", "us-central1")).toContain("us-central1-aiplatform.googleapis.com");
  });

  it("parses and validates cache resource names", () => {
    expect(parseCacheName(resourceName)).toEqual({ name: resourceName, region: "global" });
    expect(cacheResourceUrl(resourceName)).toBe(`https://aiplatform.googleapis.com/v1/${resourceName}`);
    expect(() => parseCacheName("cachedContents/no-project"))
      .toThrow("Invalid cached-content resource name");
  });
});

describe("cache create requests", () => {
  it("builds inline contents, system instruction, TTL, and model resource", () => {
    expect(buildCacheCreateBody({
      project: "study-project",
      request: request({ displayName: "Study", systemInstruction: "Use only the document." }),
    })).toEqual({
      model: "projects/study-project/locations/global/publishers/google/models/gemini-3.6-flash",
      displayName: "Study",
      systemInstruction: { role: "system", parts: [{ text: "Use only the document." }] },
      contents: [{ role: "user", parts: [{ text: "A long learning document" }] }],
      ttl: "3600s",
    });
  });

  it("builds GCS contents, an absolute expiration, and CMEK", () => {
    const value = buildCacheCreateBody({
      project: "study-project",
      request: request({
        region: "us-central1",
        content: undefined,
        files: [{ kind: "gcs", name: "manual.pdf", mimeType: "application/pdf", fileUri: "gs://study-bucket/manual.pdf" }],
        expirationMode: "expireTime",
        ttlSeconds: undefined,
        expireTime: "2099-01-01T00:00:00.000Z",
        kmsKeyName: "projects/study-project/locations/us-central1/keyRings/lab/cryptoKeys/cache",
      }),
    });
    expect(value).toMatchObject({
      contents: [{ role: "user", parts: [{ fileData: {
        fileUri: "gs://study-bucket/manual.pdf",
        mimeType: "application/pdf",
      } }] }],
      expireTime: "2099-01-01T00:00:00.000Z",
      encryptionSpec: {
        kmsKeyName: "projects/study-project/locations/us-central1/keyRings/lab/cryptoKeys/cache",
      },
    });
    expect(value).not.toHaveProperty("ttl");
  });

  it("appends file parts after the inline text in one user content", () => {
    expect(buildCacheCreateBody({
      project: "study-project",
      request: request({
        files: [
          { kind: "inlineData", name: "report.pdf", mimeType: "application/pdf", data: "JVBERi0xCg==" },
          { kind: "gcs", name: "manual.pdf", mimeType: "application/pdf", fileUri: "gs://study-bucket/manual.pdf" },
          { kind: "text", name: "notes.md", mimeType: "text/markdown", text: "Rule 7 applies." },
        ],
      }),
    })).toMatchObject({
      contents: [{
        role: "user",
        parts: [
          { text: "A long learning document" },
          { inlineData: { mimeType: "application/pdf", data: "JVBERi0xCg==" } },
          { fileData: { fileUri: "gs://study-bucket/manual.pdf", mimeType: "application/pdf" } },
          { text: "\n\n--- Cached file: notes.md (text/markdown) ---\nRule 7 applies.\n--- End cached file: notes.md ---" },
        ],
      }],
    });
  });

  it("caches files with no inline text at all", () => {
    const value = buildCacheCreateBody({
      project: "study-project",
      request: request({
        content: undefined,
        files: [{ kind: "gcs", name: "manual.pdf", mimeType: "application/pdf", fileUri: "gs://study-bucket/manual.pdf" }],
      }),
    });
    expect(value).toMatchObject({
      contents: [{ role: "user", parts: [{ fileData: { fileUri: "gs://study-bucket/manual.pdf" } }] }],
    });
  });

  it.each([
    [[{ kind: "inlineData", name: "s.pptx", mimeType: "application/zip", data: "eA==" }], "must be a PDF"],
    [[{ kind: "text", name: "notes.md", mimeType: "text/markdown", text: "   " }], "requires text"],
    [[{ kind: "gcs", name: "", mimeType: "application/pdf", fileUri: "gs://b/o.pdf" }], "requires a name"],
    [[{ kind: "video", name: "clip.mp4", mimeType: "video/mp4" }], "kind must be gcs, inlineData, or text"],
    [Array.from({ length: 11 }, () => ({ kind: "gcs", name: "o.pdf", mimeType: "application/pdf", fileUri: "gs://b/o.pdf" })), "more than 10 files"],
  ])("rejects invalid file parts: %s", (files, message) => {
    expect(() => validateCacheCreateRequest({ ...request(), files }, { modelIds: models, regionIds: regions }))
      .toThrow(message);
  });

  it("rejects inline files above the request transport limit", () => {
    expect(() => validateCacheCreateRequest({
      ...request(),
      files: [{
        kind: "inlineData",
        name: "huge.pdf",
        mimeType: "application/pdf",
        data: "A".repeat(Math.ceil(CACHE_MAX_INLINE_FILE_BYTES * 4 / 3) + 4),
      }],
    }, { modelIds: models, regionIds: regions })).toThrow("exceed 15 MB");
  });

  it("normalizes a valid text request", () => {
    expect(validateCacheCreateRequest({
      ...request(),
      project: "  study-project  ",
      displayName: "  Lab cache  ",
    }, { modelIds: models, regionIds: regions })).toMatchObject({
      project: "study-project",
      displayName: "Lab cache",
      ttlSeconds: 3600,
    });
  });

  it.each([
    [{ ...request(), model: "unsupported" }, "configured Gemini 3"],
    [{ ...request(), region: "moon-1" }, "configured cache location"],
    [{ ...request(), ttlSeconds: 59 }, "at least 60"],
    [{ ...request(), expirationMode: "expireTime", expireTime: "not-a-date" }, "valid expireTime"],
    [{ ...request(), content: undefined, files: [{ kind: "gcs", name: "f.pdf", mimeType: "application/pdf", fileUri: "https://example.test/file" }] }, "valid gs://"],
    [{ ...request(), content: undefined, files: [] }, "requires inline text, a file, or both"],
    [{ ...request(), kmsKeyName: "projects/p/locations/global/keyRings/r/cryptoKeys/k" }, "not supported with the global"],
  ])("rejects invalid input: %s", (input, message) => {
    expect(() => validateCacheCreateRequest(input, { modelIds: models, regionIds: regions }))
      .toThrow(message);
  });

  it("rejects inline text above the documented 10 MB transport limit", () => {
    expect(() => validateCacheCreateRequest({
      ...request(),
      content: "x".repeat(CACHE_MAX_INLINE_BYTES + 1),
    }, { modelIds: models, regionIds: regions })).toThrow("cannot exceed 10 MB");
  });

  it("sends a server-side bearer token without exposing it in the body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      name: resourceName,
      model: "projects/study-project/locations/global/publishers/google/models/gemini-3.6-flash",
    })) as unknown as typeof fetch;
    await createContextCache({ token: "secret-token", project: "study-project", request: request(), fetchImpl });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe(cacheCollectionUrl("study-project", "global"));
    expect(init?.headers).toMatchObject({ Authorization: "Bearer secret-token" });
    expect(String(init?.body)).not.toContain("secret-token");
  });
});

describe("cache lifecycle and evidence", () => {
  it("lists caches in a location with a bounded page size", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ cachedContents: [] })) as unknown as typeof fetch;
    await listContextCaches({ token: "token", project: "study-project", region: "global", fetchImpl });
    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe(`${cacheCollectionUrl("study-project", "global")}?pageSize=100`);
  });

  it("updates TTL with PATCH and the correct update mask", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: resourceName, model: "model", expireTime: "2099-01-01T00:00:00Z" })) as unknown as typeof fetch;
    await updateContextCacheExpiration({ token: "token", name: resourceName, expirationMode: "ttl", ttlSeconds: 7200, fetchImpl });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe(`${cacheResourceUrl(resourceName)}?updateMask=ttl`);
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ name: resourceName, ttl: "7200s" });
  });

  it("uses cachedContent and returns authoritative cache-hit metadata", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.cachedContent).toBe(resourceName);
      expect(body.contents).toEqual([{ role: "user", parts: [{ text: "What is the rule?" }] }]);
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: "Read " }, { text: "daily." }] }, finishReason: "STOP" }],
        responseId: "response-1",
        usageMetadata: {
          cachedContentTokenCount: 5000,
          promptTokenCount: 5010,
          candidatesTokenCount: 4,
          totalTokenCount: 5014,
        },
      });
    }) as unknown as typeof fetch;
    let time = 1000;
    const result = await useContextCache({
      token: "token",
      project: "study-project",
      name: resourceName,
      model: "gemini-3.6-flash",
      region: "global",
      prompt: "What is the rule?",
      fetchImpl,
      now: () => (time += 25),
    });
    expect(result).toMatchObject({
      text: "Read daily.",
      latencyMs: 25,
      finishReason: "STOP",
      responseId: "response-1",
      usageMetadata: { cachedContentTokenCount: 5000 },
      request: { cachedContent: resourceName },
    });
  });

  it("surfaces actionable provider errors", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: "Model does not support context caching." } }, { status: 400 })) as unknown as typeof fetch;
    await expect(createContextCache({ token: "token", project: "study-project", request: request(), fetchImpl }))
      .rejects.toThrow("Model does not support context caching");
  });

  it("deletes the exact resource with DELETE", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    await deleteContextCache({ token: "token", name: resourceName, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(cacheResourceUrl(resourceName), expect.objectContaining({ method: "DELETE" }));
  });
});

describe("cache test API", () => {
  it("returns safe config without credentials", async () => {
    const response = await supertest(createApp()).get("/api/tests/cache/config");
    expect(response.status).toBe(200);
    expect(response.body.defaults).toMatchObject({ ttlSeconds: 3600 });
    expect(response.body.limits).toMatchObject({ minimumTokensGemini3: 4096, minimumTtlSeconds: 60 });
    expect(JSON.stringify(response.body)).not.toMatch(/access.?token|authorization|private.?key/i);
  });

  it("creates through the namespaced route with injected, server-only auth", async () => {
    const getAccessToken = vi.fn(async () => "server-token");
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer server-token" });
      return jsonResponse({
        name: resourceName,
        model: "projects/study-project/locations/global/publishers/google/models/gemini-3.6-flash",
        usageMetadata: { totalTokenCount: 5000 },
      });
    }) as unknown as typeof fetch;
    const response = await supertest(createApp({ fetchImpl, getAccessToken }))
      .post("/api/tests/cache/create")
      .send({ project: "study-project", ...request() });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ name: resourceName, usageMetadata: { totalTokenCount: 5000 } });
    expect(getAccessToken).toHaveBeenCalledOnce();
  });

  it("rejects invalid cache input before requesting credentials", async () => {
    const getAccessToken = vi.fn(async () => "server-token");
    const response = await supertest(createApp({ getAccessToken }))
      .post("/api/tests/cache/create")
      .send({ project: "study-project", ...request({ ttlSeconds: 30 }) });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("at least 60 seconds");
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it("prevents using a cache through a different location", async () => {
    const getAccessToken = vi.fn(async () => "server-token");
    const response = await supertest(createApp({ getAccessToken }))
      .post("/api/tests/cache/use")
      .send({
        project: "study-project",
        name: resourceName,
        model: "gemini-3.6-flash",
        region: "us-central1",
        prompt: "Question",
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("must match the cache location");
    expect(getAccessToken).not.toHaveBeenCalled();
  });
});
