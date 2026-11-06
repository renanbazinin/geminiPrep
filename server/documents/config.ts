import path from "node:path";
import {
  createLargeFiles as createPackageLargeFiles,
  FileDocumentStore as PackageFileDocumentStore,
  type LargeFiles as PackageLargeFiles,
} from "llm-large-files";
import type { LargeFilesConfig } from "../../shared/contracts.js";
import {
  createLargeFiles as createOriginalLargeFiles,
  DEFAULT_BUDGET,
  FileDocumentStore as OriginalFileDocumentStore,
  type LargeFiles as OriginalLargeFiles,
} from "../../packages/large-files/src/index.js";

const MB = 1024 * 1024;

/**
 * Which large-file implementation runs:
 * - "npm": the published llm-large-files package, with its askGemini tool loop and upload handlers.
 * - "original": the in-repo packages/large-files code and this app's own tool loop.
 */
export type LargeFilesEngine = "npm" | "original";
export const LARGE_FILES_ENGINES: readonly LargeFilesEngine[] = ["npm", "original"];

/** A large-file library together with the engine that serves it. */
export type ServerLargeFiles =
  | { engine: "npm"; files: PackageLargeFiles }
  | { engine: "original"; files: OriginalLargeFiles };

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** LARGE_FILES_ENGINE: "npm" (the default) or "original". Any other value is a startup error. */
export function resolveLargeFilesEngine(): LargeFilesEngine {
  const raw = process.env.LARGE_FILES_ENGINE?.trim().toLowerCase();
  if (!raw) return "npm";
  if ((LARGE_FILES_ENGINES as readonly string[]).includes(raw)) return raw as LargeFilesEngine;
  throw new Error(`LARGE_FILES_ENGINE must be ${LARGE_FILES_ENGINES.map((name) => `"${name}"`).join(" or ")}, not "${process.env.LARGE_FILES_ENGINE}".`);
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

/**
 * Creates the large-file library for the engine in LARGE_FILES_ENGINE. Both engines keep files in
 * the same directory and format, so switching engines keeps uploads that have not expired.
 */
export function createServerLargeFiles(engine: LargeFilesEngine = resolveLargeFilesEngine()): ServerLargeFiles {
  const settings = resolveLargeFilesSettings();
  const options = {
    ttlMs: settings.ttlHours * 60 * 60 * 1000,
    maxUploadBytes: settings.maxUploadBytes,
    budget: settings.budget,
  };
  return engine === "npm"
    ? { engine, files: createPackageLargeFiles({ ...options, store: new PackageFileDocumentStore(settings.directory) }) }
    : { engine, files: createOriginalLargeFiles({ ...options, store: new OriginalFileDocumentStore(settings.directory) }) };
}

export function describeLargeFilesEngine(engine: LargeFilesEngine): string {
  return engine === "npm" ? "llm-large-files npm package" : "original in-repo code (packages/large-files)";
}
