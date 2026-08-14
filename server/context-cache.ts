import type {
  CacheCreateRequest,
  CachedContentResource,
  CacheUseResult,
} from "../shared/contracts.js";
import { vertexGenerateContentUrl, vertexHost } from "./region-probe.js";

const CACHE_NAME_PATTERN = /^projects\/[A-Za-z0-9._-]+\/locations\/([a-z0-9-]+)\/cachedContents\/[A-Za-z0-9_-]+$/;
export const CACHE_MIN_TTL_SECONDS = 60;
export const CACHE_DEFAULT_TTL_SECONDS = 3600;
export const CACHE_MAX_INLINE_BYTES = 10 * 1024 * 1024;
export const GEMINI_3_MIN_CACHE_TOKENS = 4096;

type FetchLike = typeof fetch;

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function apiError(value: unknown, status: number): Error {
  const body = value as { error?: { message?: unknown } } | null;
  const message = typeof body?.error?.message === "string"
    ? body.error.message
    : `Vertex cache API returned HTTP ${status}.`;
  return new Error(message);
}

async function checkedJson(response: Response): Promise<unknown> {
  const value = await responseJson(response);
  if (!response.ok) throw apiError(value, response.status);
  return value;
}

export function cacheCollectionUrl(project: string, region: string): string {
  return `${vertexHost(region)}/v1/projects/${project}/locations/${region}/cachedContents`;
}

export function parseCacheName(name: string): { name: string; region: string } {
  const match = CACHE_NAME_PATTERN.exec(name);
  if (!match?.[1]) throw new Error("Invalid cached-content resource name.");
  return { name, region: match[1] };
}

export function cacheResourceUrl(name: string): string {
  const parsed = parseCacheName(name);
  return `${vertexHost(parsed.region)}/v1/${parsed.name}`;
}

export function buildCacheCreateBody(options: {
  project: string;
  request: CacheCreateRequest;
}): Record<string, unknown> {
  const { project, request } = options;
  const contents = request.contentMode === "gcs"
    ? [{
        role: "user",
        parts: [{ fileData: { fileUri: request.gcsUri, mimeType: request.mimeType } }],
      }]
    : [{ role: "user", parts: [{ text: request.content }] }];
  return {
    model: `projects/${project}/locations/${request.region}/publishers/google/models/${request.model}`,
    ...(request.displayName ? { displayName: request.displayName } : {}),
    ...(request.systemInstruction
      ? { systemInstruction: { role: "system", parts: [{ text: request.systemInstruction }] } }
      : {}),
    contents,
    ...(request.expirationMode === "expireTime"
      ? { expireTime: request.expireTime }
      : { ttl: `${request.ttlSeconds}s` }),
    ...(request.kmsKeyName ? { encryptionSpec: { kmsKeyName: request.kmsKeyName } } : {}),
  };
}

export function validateCacheCreateRequest(
  body: unknown,
  options: { modelIds: string[]; regionIds: string[] },
): CacheCreateRequest {
  if (!body || typeof body !== "object") throw new Error("A JSON request body is required.");
  const input = body as Record<string, unknown>;
  if (typeof input.model !== "string" || !options.modelIds.includes(input.model)) {
    throw new Error("Choose a configured Gemini 3 cache model.");
  }
  if (typeof input.region !== "string" || !options.regionIds.includes(input.region)) {
    throw new Error("Choose a configured cache location.");
  }
  const displayName = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (displayName.length > 128) throw new Error("displayName cannot exceed 128 characters.");
  const systemInstruction = typeof input.systemInstruction === "string"
    ? input.systemInstruction.trim()
    : "";
  if (systemInstruction.length > 20_000) throw new Error("systemInstruction cannot exceed 20,000 characters.");
  const contentMode = input.contentMode;
  if (contentMode !== "text" && contentMode !== "gcs") throw new Error("contentMode must be text or gcs.");

  let content: string | undefined;
  let gcsUri: string | undefined;
  let mimeType: string | undefined;
  if (contentMode === "text") {
    if (typeof input.content !== "string" || !input.content.trim()) throw new Error("Text content is required.");
    if (Buffer.byteLength(input.content, "utf8") > CACHE_MAX_INLINE_BYTES) {
      throw new Error("Inline text cannot exceed 10 MB; use a Cloud Storage URI instead.");
    }
    content = input.content;
  } else {
    if (typeof input.gcsUri !== "string" || !/^gs:\/\/[A-Za-z0-9._-]+\/.+/.test(input.gcsUri)) {
      throw new Error("A valid gs:// Cloud Storage URI is required.");
    }
    if (typeof input.mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType)) {
      throw new Error("A valid MIME type is required for Cloud Storage content.");
    }
    gcsUri = input.gcsUri;
    mimeType = input.mimeType;
  }

  const expirationMode = input.expirationMode;
  if (expirationMode !== "ttl" && expirationMode !== "expireTime") {
    throw new Error("expirationMode must be ttl or expireTime.");
  }
  let ttlSeconds: number | undefined;
  let expireTime: string | undefined;
  if (expirationMode === "ttl") {
    ttlSeconds = Number(input.ttlSeconds);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < CACHE_MIN_TTL_SECONDS) {
      throw new Error(`TTL must be at least ${CACHE_MIN_TTL_SECONDS} seconds.`);
    }
  } else {
    if (typeof input.expireTime !== "string" || !Number.isFinite(Date.parse(input.expireTime))) {
      throw new Error("A valid expireTime is required.");
    }
    if (Date.parse(input.expireTime) < Date.now() + CACHE_MIN_TTL_SECONDS * 1000) {
      throw new Error("expireTime must be at least one minute in the future.");
    }
    expireTime = new Date(input.expireTime).toISOString();
  }

  const kmsKeyName = typeof input.kmsKeyName === "string" ? input.kmsKeyName.trim() : "";
  if (kmsKeyName && input.region === "global") {
    throw new Error("CMEK is not supported with the global endpoint; choose a regional location.");
  }
  if (kmsKeyName && !/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(kmsKeyName)) {
    throw new Error("kmsKeyName must be a full Cloud KMS CryptoKey resource name.");
  }

  return {
    ...(typeof input.project === "string" && input.project.trim() ? { project: input.project.trim() } : {}),
    model: input.model,
    region: input.region,
    ...(displayName ? { displayName } : {}),
    ...(systemInstruction ? { systemInstruction } : {}),
    contentMode,
    ...(content ? { content } : {}),
    ...(gcsUri ? { gcsUri } : {}),
    ...(mimeType ? { mimeType } : {}),
    expirationMode,
    ...(ttlSeconds ? { ttlSeconds } : {}),
    ...(expireTime ? { expireTime } : {}),
    ...(kmsKeyName ? { kmsKeyName } : {}),
  };
}

export async function createContextCache(options: {
  token: string;
  project: string;
  request: CacheCreateRequest;
  fetchImpl?: FetchLike;
}): Promise<CachedContentResource> {
  const { token, project, request, fetchImpl = fetch } = options;
  const response = await fetchImpl(cacheCollectionUrl(project, request.region), {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify(buildCacheCreateBody({ project, request })),
  });
  return checkedJson(response) as Promise<CachedContentResource>;
}

export async function listContextCaches(options: {
  token: string;
  project: string;
  region: string;
  fetchImpl?: FetchLike;
}): Promise<{ cachedContents: CachedContentResource[]; nextPageToken?: string }> {
  const { token, project, region, fetchImpl = fetch } = options;
  const response = await fetchImpl(`${cacheCollectionUrl(project, region)}?pageSize=100`, {
    headers: authHeaders(token),
  });
  return checkedJson(response) as Promise<{ cachedContents: CachedContentResource[]; nextPageToken?: string }>;
}

export async function getContextCache(options: {
  token: string;
  name: string;
  fetchImpl?: FetchLike;
}): Promise<CachedContentResource> {
  const response = await (options.fetchImpl ?? fetch)(cacheResourceUrl(options.name), {
    headers: authHeaders(options.token),
  });
  return checkedJson(response) as Promise<CachedContentResource>;
}

export async function updateContextCacheExpiration(options: {
  token: string;
  name: string;
  expirationMode: "ttl" | "expireTime";
  ttlSeconds?: number;
  expireTime?: string;
  fetchImpl?: FetchLike;
}): Promise<CachedContentResource> {
  const { token, name, expirationMode, fetchImpl = fetch } = options;
  const body = expirationMode === "ttl"
    ? { name, ttl: `${options.ttlSeconds}s` }
    : { name, expireTime: options.expireTime };
  const response = await fetchImpl(
    `${cacheResourceUrl(name)}?updateMask=${expirationMode === "ttl" ? "ttl" : "expireTime"}`,
    { method: "PATCH", headers: authHeaders(token), body: JSON.stringify(body) },
  );
  return checkedJson(response) as Promise<CachedContentResource>;
}

export async function deleteContextCache(options: {
  token: string;
  name: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(cacheResourceUrl(options.name), {
    method: "DELETE",
    headers: authHeaders(options.token),
  });
  if (!response.ok) throw apiError(await responseJson(response), response.status);
}

export async function useContextCache(options: {
  token: string;
  project: string;
  name: string;
  model: string;
  region: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<CacheUseResult> {
  const {
    token,
    project,
    name,
    model,
    region,
    prompt,
    temperature = 0.2,
    maxOutputTokens = 512,
    fetchImpl = fetch,
    now = () => Date.now(),
  } = options;
  const startedAt = now();
  const response = await fetchImpl(vertexGenerateContentUrl({ project, region, model }), {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      cachedContent: name,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens },
    }),
  });
  const value = await checkedJson(response) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> }; finishReason?: string }>;
    usageMetadata?: CacheUseResult["usageMetadata"];
    responseId?: string;
  };
  const text = (value.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
  return {
    text,
    latencyMs: now() - startedAt,
    finishReason: value.candidates?.[0]?.finishReason,
    responseId: value.responseId,
    usageMetadata: value.usageMetadata,
    request: { model, region, cachedContent: name, prompt },
  };
}
