import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  createLargeFiles as createPackageLargeFiles,
  FileDocumentStore as PackageFileDocumentStore,
  type LargeFiles as PackageLargeFiles,
} from "llm-large-files";
import type { GeminiToolFilePlacement } from "llm-large-files/gemini";
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

/** A yes/no setting. Unset keeps the fallback; "0", "false", "off" and "no" turn it off. */
function enabled(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * LARGE_FILES_PAGE_PLACEMENT: where the pages of a PDF go in the request when the model asks to
 * look at them. "inside" (the default) puts them in the function response itself, which Gemini 3
 * models read on Vertex AI and on the Gemini API. "beside" sends them as parts next to it: Vertex
 * AI refuses that for Gemini 3 models (HTTP 400), while Gemini 2.5 on Vertex AI sees pages only
 * that way. Measured with scripts/large-files-pages-live-check.ts in November 2026.
 */
export function resolvePagePlacement(): GeminiToolFilePlacement {
  const raw = process.env.LARGE_FILES_PAGE_PLACEMENT?.trim().toLowerCase();
  if (!raw) return "inside";
  if (raw === "inside" || raw === "beside") return raw;
  throw new Error(`LARGE_FILES_PAGE_PLACEMENT must be "inside" or "beside", not "${process.env.LARGE_FILES_PAGE_PLACEMENT}".`);
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
    /** The limit on tool use in one answer: after one round of tool calls fewer than this, the model must answer without tools. */
    maxToolTurns: Math.max(1, Math.round(positive("LARGE_FILES_MAX_TOOL_TURNS", 12))),
    /**
     * Keep each uploaded PDF next to its text, so the model can look at its pages (pictures,
     * charts, scans). On by default. Only the npm engine does this. A kept PDF takes as much disk
     * as the upload until it expires.
     */
    keepPdfs: enabled("LARGE_FILES_KEEP_PDFS", true),
    pagePlacement: resolvePagePlacement(),
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
    ? { engine, files: createPackageLargeFiles({ ...options, store: new PackageFileDocumentStore(settings.directory), keepOriginals: settings.keepPdfs ? ["pdf"] : [] }) }
    : { engine, files: createOriginalLargeFiles({ ...options, store: new OriginalFileDocumentStore(settings.directory) }) };
}

const ORIGINAL_FILE = /^(doc_[a-f0-9]{32})\.bin$/;
/** A kept PDF is written before the rest of its document, so one that is this young may still be on its way in. */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * Removes kept PDFs (`<id>.bin`) whose document is gone, and returns how many. The npm engine
 * removes a kept PDF with its document. The original engine does not know these files: a document
 * that expires or is deleted while it runs leaves its PDF behind, up to the upload limit each.
 */
export async function removeOrphanOriginals(directory = resolveLargeFilesSettings().directory, now = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return 0;
  }
  const present = new Set(entries);
  let removed = 0;
  for (const entry of entries) {
    const id = ORIGINAL_FILE.exec(entry)?.[1];
    if (!id || present.has(`${id}.json`)) continue;
    const file = path.join(directory, entry);
    const modified = await stat(file).then((info) => info.mtimeMs, () => undefined);
    if (modified === undefined || now - modified < ORPHAN_AGE_MS) continue;
    await rm(file, { force: true });
    removed++;
  }
  return removed;
}

export function describeLargeFilesEngine(engine: LargeFilesEngine): string {
  return engine === "npm" ? "llm-large-files npm package" : "original in-repo code (packages/large-files)";
}
