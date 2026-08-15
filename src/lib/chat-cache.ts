import type {
  AppSettings,
  CacheFilePart,
  CacheTestConfig,
  CachedContentResource,
  ChatRequestFilePart,
  StoredCacheEntry,
} from "../../shared/contracts";
import { cacheSignature, findLiveCache, rememberCache } from "./cache-registry";

export type CacheAttempt =
  | { status: "hit"; entry: StoredCacheEntry }
  | { status: "created"; entry: StoredCacheEntry }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Signatures Vertex already refused, so a conversation does not retry a doomed create
 * on every single message. Session-scoped on purpose: a reload re-evaluates.
 */
const refused = new Map<string, string>();

let cacheConfig: Promise<CacheTestConfig> | null = null;

export function loadCacheConfig(): Promise<CacheTestConfig> {
  if (!cacheConfig) {
    cacheConfig = fetch("/api/tests/cache/config").then(async (response) => {
      const value = await response.json() as CacheTestConfig & { error?: string };
      if (!response.ok || value.error) throw new Error(value.error ?? "Could not load cache configuration.");
      return value;
    }).catch((reason: unknown) => {
      cacheConfig = null;
      throw reason;
    });
  }
  return cacheConfig;
}

/** Rough character-based estimate; binary parts are counted by Vertex, not here. */
function estimateTextTokens(systemInstruction: string, files: CacheFilePart[]): number {
  const characters = systemInstruction.length
    + files.reduce((total, file) => total + (file.kind === "text" ? file.text.length : 0), 0);
  return Math.ceil(characters / 4);
}

/**
 * Finds or creates the cache backing this conversation. Creation is billable, so the caller
 * must only reach here with settings.cacheEnabled on.
 */
export async function ensureSessionCache(options: {
  settings: AppSettings;
  project: string | null;
  files: ChatRequestFilePart[];
  now?: () => number;
}): Promise<CacheAttempt> {
  const { settings, project, files, now = () => Date.now() } = options;
  if (settings.provider !== "vertex") {
    return { status: "skipped", reason: "Context caching is a Vertex AI feature." };
  }
  if (!project) return { status: "skipped", reason: "No Google Cloud project is configured." };
  if (files.length === 0) return { status: "skipped", reason: "This conversation has no files to cache." };

  const model = settings.models.vertex;
  const region = settings.region;
  const parts: CacheFilePart[] = files;
  const signature = cacheSignature({
    model,
    region,
    systemInstruction: settings.systemInstruction,
    files: parts,
  });

  const existing = findLiveCache(signature, model, region, now());
  if (existing) return { status: "hit", entry: existing };

  const previouslyRefused = refused.get(signature);
  if (previouslyRefused) return { status: "failed", reason: previouslyRefused };

  let config: CacheTestConfig;
  try {
    config = await loadCacheConfig();
  } catch (reason) {
    return { status: "failed", reason: reason instanceof Error ? reason.message : String(reason) };
  }
  if (!config.models.some((candidate) => candidate.id === model)) {
    return { status: "skipped", reason: `${model} does not support explicit context caching.` };
  }
  // Text-only material can be measured up front; a PDF's token count is only known to Vertex.
  const hasBinary = parts.some((file) => file.kind !== "text");
  const estimated = estimateTextTokens(settings.systemInstruction, parts);
  if (!hasBinary && estimated < config.limits.minimumTokensGemini3) {
    return {
      status: "skipped",
      reason: `About ${estimated.toLocaleString()} tokens is below the ${config.limits.minimumTokensGemini3.toLocaleString()}-token minimum.`,
    };
  }

  try {
    const response = await fetch("/api/tests/cache/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project,
        model,
        region,
        displayName: `gemini-prep-chat-${signature}`,
        systemInstruction: settings.systemInstruction,
        files: parts,
        expirationMode: "ttl",
        ttlSeconds: settings.cacheTtlSeconds,
      }),
    });
    const created = await response.json() as CachedContentResource & { error?: string };
    if (!response.ok || created.error) throw new Error(created.error ?? "Could not create the cache.");
    if (!created.name || !created.expireTime) throw new Error("Vertex did not return a usable cache resource.");
    const entry: StoredCacheEntry = {
      name: created.name,
      ...(created.displayName ? { displayName: created.displayName } : {}),
      model,
      region,
      signature,
      createdAt: created.createTime ?? new Date(now()).toISOString(),
      expireTime: created.expireTime,
      ...(created.usageMetadata?.totalTokenCount === undefined
        ? {}
        : { cachedTokens: created.usageMetadata.totalTokenCount }),
    };
    rememberCache(entry, now());
    return { status: "created", entry };
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    refused.set(signature, message);
    return { status: "failed", reason: message };
  }
}

export function clearRefusedCaches(): void {
  refused.clear();
}
