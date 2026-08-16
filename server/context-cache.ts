import type {
  CacheCreateRequest,
  CachedContentResource,
  CacheFilePart,
  CacheUseResult,
  ImplicitCacheCall,
  ImplicitCacheProbeResult,
  ThinkingLevel,
} from "../shared/contracts.js";
import { vertexGenerateContentUrl, vertexHost } from "./region-probe.js";

const CACHE_NAME_PATTERN = /^projects\/[A-Za-z0-9._-]+\/locations\/([a-z0-9-]+)\/cachedContents\/[A-Za-z0-9_-]+$/;
export const CACHE_MIN_TTL_SECONDS = 60;
export const CACHE_DEFAULT_TTL_SECONDS = 3600;
export const CACHE_MAX_INLINE_BYTES = 10 * 1024 * 1024;
export const GEMINI_3_MIN_CACHE_TOKENS = 4096;
export const CACHE_MAX_FILE_PARTS = 10;
/** Vertex rejects oversized requests, so keep every base64 `inlineData` part in one request under this. */
export const CACHE_MAX_INLINE_FILE_BYTES = 15 * 1024 * 1024;

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

function cacheFilePartToVertexPart(file: CacheFilePart): Record<string, unknown> {
  if (file.kind === "gcs") return { fileData: { fileUri: file.fileUri, mimeType: file.mimeType } };
  if (file.kind === "inlineData") return { inlineData: { mimeType: file.mimeType, data: file.data } };
  return { text: `\n\n--- Cached file: ${file.name} (${file.mimeType}) ---\n${file.text}\n--- End cached file: ${file.name} ---` };
}

export function buildCacheCreateBody(options: {
  project: string;
  request: CacheCreateRequest;
}): Record<string, unknown> {
  const { project, request } = options;
  const parts: Record<string, unknown>[] = [
    ...(request.content ? [{ text: request.content }] : []),
    ...(request.files ?? []).map((file) => cacheFilePartToVertexPart(file)),
  ];
  const contents = [{ role: "user", parts }];
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

const MIME_TYPE_PATTERN = /^[\w.+-]+\/[\w.+-]+$/;
const GCS_URI_PATTERN = /^gs:\/\/[A-Za-z0-9._-]+\/.+/;

export function validateCacheFiles(value: unknown): CacheFilePart[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("files must be an array.");
  if (value.length > CACHE_MAX_FILE_PARTS) {
    throw new Error(`A cache cannot hold more than ${CACHE_MAX_FILE_PARTS} files.`);
  }
  let inlineBytes = 0;
  const files = value.map((entry, index) => {
    const label = `files[${index}]`;
    if (!entry || typeof entry !== "object") throw new Error(`${label} must be an object.`);
    const file = entry as Record<string, unknown>;
    const name = typeof file.name === "string" && file.name.trim() ? file.name.trim() : "";
    if (!name) throw new Error(`${label} requires a name.`);
    if (typeof file.mimeType !== "string" || !MIME_TYPE_PATTERN.test(file.mimeType)) {
      throw new Error(`${label} requires a valid MIME type.`);
    }
    if (file.kind === "gcs") {
      if (typeof file.fileUri !== "string" || !GCS_URI_PATTERN.test(file.fileUri)) {
        throw new Error(`${label} requires a valid gs:// Cloud Storage URI.`);
      }
      return { kind: "gcs" as const, name, mimeType: file.mimeType, fileUri: file.fileUri };
    }
    if (file.kind === "inlineData") {
      if (file.mimeType !== "application/pdf") {
        throw new Error(`${label} inlineData must be a PDF; extract other formats to text first.`);
      }
      if (typeof file.data !== "string" || !file.data) throw new Error(`${label} requires base64 data.`);
      inlineBytes += Math.floor(file.data.length * 3 / 4);
      return { kind: "inlineData" as const, name, mimeType: file.mimeType, data: file.data };
    }
    if (file.kind === "text") {
      if (typeof file.text !== "string" || !file.text.trim()) throw new Error(`${label} requires text.`);
      return { kind: "text" as const, name, mimeType: file.mimeType, text: file.text };
    }
    throw new Error(`${label}.kind must be gcs, inlineData, or text.`);
  });
  if (inlineBytes > CACHE_MAX_INLINE_FILE_BYTES) {
    throw new Error("Inline files exceed 15 MB in one request; upload them to Cloud Storage and cache the gs:// URI instead.");
  }
  return files;
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
  let content: string | undefined;
  if (input.content !== undefined && input.content !== null && input.content !== "") {
    if (typeof input.content !== "string") throw new Error("content must be a string.");
    if (Buffer.byteLength(input.content, "utf8") > CACHE_MAX_INLINE_BYTES) {
      throw new Error("Inline text cannot exceed 10 MB; use a Cloud Storage URI instead.");
    }
    if (input.content.trim()) content = input.content;
  }
  const files = validateCacheFiles(input.files);
  if (!content && files.length === 0) {
    throw new Error("Cached content requires inline text, a file, or both.");
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
    ...(content ? { content } : {}),
    ...(files.length ? { files } : {}),
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

async function generateContent(options: {
  token: string;
  project: string;
  model: string;
  region: string;
  body: Record<string, unknown>;
  fetchImpl: FetchLike;
  now: () => number;
}): Promise<{
  text: string;
  latencyMs: number;
  finishReason?: string;
  responseId?: string;
  usageMetadata?: CacheUseResult["usageMetadata"];
}> {
  const startedAt = options.now();
  const response = await options.fetchImpl(
    vertexGenerateContentUrl({ project: options.project, region: options.region, model: options.model }),
    { method: "POST", headers: authHeaders(options.token), body: JSON.stringify(options.body) },
  );
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
    latencyMs: options.now() - startedAt,
    finishReason: value.candidates?.[0]?.finishReason,
    responseId: value.responseId,
    usageMetadata: value.usageMetadata,
  };
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
  thinkingLevel?: ThinkingLevel;
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
    maxOutputTokens = 2048,
    thinkingLevel,
    fetchImpl = fetch,
    now = () => Date.now(),
  } = options;
  const generated = await generateContent({
    token,
    project,
    model,
    region,
    fetchImpl,
    now,
    body: {
      cachedContent: name,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens,
        ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
      },
    },
  });
  return { ...generated, request: { model, region, cachedContent: name, prompt } };
}

export async function probeImplicitCache(options: {
  token: string;
  project: string;
  model: string;
  region: string;
  prefix: string;
  questions: [string, string];
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<ImplicitCacheProbeResult> {
  const {
    token,
    project,
    model,
    region,
    prefix,
    questions,
    fetchImpl = fetch,
    now = () => Date.now(),
  } = options;
  const sequence = [questions[0], questions[1], questions[0], questions[1]];
  const calls: ImplicitCacheCall[] = [];
  for (const question of sequence) {
    const generated = await generateContent({
      token,
      project,
      model,
      region,
      fetchImpl,
      now,
      body: {
        systemInstruction: { parts: [{ text: prefix }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 256,
          ...(model.startsWith("gemini-3") ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
        },
      },
    });
    calls.push({ question, ...generated });
  }
  if (calls.length !== 4) throw new Error("Implicit cache probe did not complete all four requests.");
  const cachedTokens = Math.max(
    0,
    ...calls.map((call) => Number(call.usageMetadata?.cachedContentTokenCount ?? 0)),
  );
  return {
    model,
    region,
    prefixCharacters: prefix.length,
    calls,
    cachedTokens: Number.isFinite(cachedTokens) ? cachedTokens : 0,
    hit: Number.isFinite(cachedTokens) && cachedTokens > 0,
  };
}
