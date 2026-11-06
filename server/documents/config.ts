import path from "node:path";
import type { LargeFilesConfig } from "../../shared/contracts.js";
import { createLargeFiles, DEFAULT_BUDGET, FileDocumentStore, type LargeFiles } from "../../packages/large-files/src/index.js";

const MB = 1024 * 1024;

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Limits from the environment. Defaults model an enterprise Gemini connector: 10 MB requests, 1M tokens. */
export function resolveLargeFilesSettings() {
  return {
    directory: process.env.LARGE_FILES_DIR?.trim() || path.resolve(process.cwd(), ".data", "large-files"),
    ttlHours: positive("LARGE_FILES_TTL_HOURS", 72),
    maxUploadBytes: Math.round(positive("LARGE_FILES_MAX_UPLOAD_MB", 100) * MB),
    serverThresholdBytes: Math.round(positive("LARGE_FILES_SERVER_THRESHOLD_KB", 512) * 1024),
    pdfInlineMaxBytes: Math.round(positive("LARGE_FILES_PDF_INLINE_MAX_MB", 7) * MB),
    /** Model turns that may call tools in one answer, before a final tool-free turn. */
    maxToolTurns: Math.max(1, Math.round(positive("LARGE_FILES_MAX_TOOL_TURNS", 12))),
    budget: {
      contextTokens: positive("LARGE_FILES_CONTEXT_TOKENS", DEFAULT_BUDGET.contextTokens),
      maxRequestBytes: positive("LARGE_FILES_MAX_REQUEST_BYTES", DEFAULT_BUDGET.maxRequestBytes),
      inlineTokens: positive("LARGE_FILES_INLINE_TOKENS", DEFAULT_BUDGET.inlineTokens),
      mapChunkTokens: positive("LARGE_FILES_MAP_CHUNK_TOKENS", DEFAULT_BUDGET.mapChunkTokens),
      maxMapChunks: positive("LARGE_FILES_MAX_MAP_CHUNKS", DEFAULT_BUDGET.maxMapChunks),
    },
  };
}

export function publicLargeFilesConfig(): LargeFilesConfig {
  const settings = resolveLargeFilesSettings();
  return {
    maxUploadBytes: settings.maxUploadBytes,
    serverThresholdBytes: settings.serverThresholdBytes,
    pdfInlineMaxBytes: settings.pdfInlineMaxBytes,
    ttlHours: settings.ttlHours,
  };
}

export function createServerLargeFiles(): LargeFiles {
  const settings = resolveLargeFilesSettings();
  return createLargeFiles({
    store: new FileDocumentStore(settings.directory),
    ttlMs: settings.ttlHours * 60 * 60 * 1000,
    maxUploadBytes: settings.maxUploadBytes,
    budget: settings.budget,
  });
}
