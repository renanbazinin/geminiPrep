// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { StoredCacheEntry } from "../../shared/contracts";
import {
  cacheSignature,
  findLiveCache,
  forgetCache,
  formatRemaining,
  isLive,
  loadCaches,
  rememberCache,
  remainingMs,
} from "./cache-registry";

const now = Date.parse("2026-08-15T12:00:00.000Z");

function entry(overrides: Partial<StoredCacheEntry> = {}): StoredCacheEntry {
  return {
    name: "projects/study-project/locations/global/cachedContents/cache_1",
    model: "gemini-3.6-flash",
    region: "global",
    signature: "sig-1",
    createdAt: "2026-08-15T11:00:00.000Z",
    expireTime: "2026-08-15T13:00:00.000Z",
    ...overrides,
  };
}

describe("cache registry", () => {
  beforeEach(() => localStorage.clear());

  it("stores a cache and finds it again by signature, model, and location", () => {
    rememberCache(entry(), now);
    expect(findLiveCache("sig-1", "gemini-3.6-flash", "global", now)?.name).toContain("cache_1");
    expect(findLiveCache("sig-1", "gemini-3.6-flash", "us-central1", now)).toBeUndefined();
    expect(findLiveCache("sig-1", "gemini-3.7-flash", "global", now)).toBeUndefined();
    expect(findLiveCache("other", "gemini-3.6-flash", "global", now)).toBeUndefined();
  });

  it("drops expired caches on read, because Vertex has already stopped serving them", () => {
    rememberCache(entry({ expireTime: "2026-08-15T11:59:59.000Z" }), now);
    expect(loadCaches(now)).toEqual([]);
    expect(findLiveCache("sig-1", "gemini-3.6-flash", "global", now)).toBeUndefined();
  });

  it("replaces an entry with the same resource name instead of duplicating it", () => {
    rememberCache(entry(), now);
    rememberCache(entry({ cachedTokens: 9819 }), now);
    expect(loadCaches(now)).toHaveLength(1);
    expect(loadCaches(now)[0].cachedTokens).toBe(9819);
  });

  it("forgets one cache and keeps the rest", () => {
    rememberCache(entry(), now);
    rememberCache(entry({ name: "projects/p/locations/global/cachedContents/cache_2", signature: "sig-2" }), now);
    expect(forgetCache("projects/study-project/locations/global/cachedContents/cache_1", now)).toHaveLength(1);
    expect(loadCaches(now)[0].signature).toBe("sig-2");
  });

  it("survives corrupt local data", () => {
    localStorage.setItem("gemini-prep:caches:v1", "{not json");
    expect(loadCaches(now)).toEqual([]);
  });

  it("reports remaining lifetime", () => {
    expect(isLive(entry(), now)).toBe(true);
    expect(remainingMs(entry(), now)).toBe(3_600_000);
    expect(remainingMs(entry({ expireTime: "2026-08-15T11:00:00.000Z" }), now)).toBe(0);
    expect(formatRemaining(3_600_000)).toBe("1h 00m 00s");
    expect(formatRemaining(61_000)).toBe("0h 01m 01s");
  });

  it("changes the signature when any immutable part of the cached material changes", () => {
    const base = {
      model: "gemini-3.6-flash",
      region: "global",
      systemInstruction: "Answer from the document.",
      files: [{ kind: "text" as const, name: "a.md", mimeType: "text/markdown", text: "hello" }],
    };
    const signature = cacheSignature(base);
    expect(cacheSignature(base)).toBe(signature);
    expect(cacheSignature({ ...base, model: "gemini-3.7-flash" })).not.toBe(signature);
    expect(cacheSignature({ ...base, region: "us-central1" })).not.toBe(signature);
    expect(cacheSignature({ ...base, systemInstruction: "Something else." })).not.toBe(signature);
    expect(cacheSignature({
      ...base,
      files: [...base.files, { kind: "text", name: "b.md", mimeType: "text/markdown", text: "more" }],
    })).not.toBe(signature);
  });
});
