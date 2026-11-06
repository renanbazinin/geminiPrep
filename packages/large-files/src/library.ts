import { randomUUID } from "node:crypto";
import { buildLogProfile, buildOutline, looksLikeLog } from "./analyze.js";
import { detectFormat, extractText } from "./extract.js";
import { documentToolsInstruction, planDocuments, renderCard, renderInline } from "./plan.js";
import { SearchableDocument } from "./search.js";
import { DOCUMENT_ID_PATTERN } from "./stores.js";
import { estimateTokens, normalizeText, utf8Bytes, wrapLongLines } from "./text.js";
import { createDocumentTools } from "./tools.js";
import type {
  Budget,
  DocumentFormat,
  DocumentMeta,
  DocumentStore,
  Extractor,
  GenerateText,
  PreparedContext,
  ProgressListener,
  ToolSet,
} from "./types.js";

/** Defaults sized for a 1M-token model behind a 10 MB request limit. */
export const DEFAULT_BUDGET: Budget = {
  contextTokens: 1_000_000,
  maxRequestBytes: 10_000_000,
  inlineTokens: 200_000,
  reservedTokens: 64_000,
  mapChunkTokens: 100_000,
  maxMapChunks: 30,
  toolResultCharacters: 24_000,
};

export type LargeFilesOptions = {
  store: DocumentStore;
  budget?: Partial<Budget>;
  /** How long uploaded documents are kept. Defaults to 72 hours. */
  ttlMs?: number;
  /** Largest accepted upload. Defaults to 100 MB. */
  maxUploadBytes?: number;
  /** Override or add text extractors per format. */
  extractors?: Partial<Record<DocumentFormat, Extractor>>;
  /** How many parsed documents to keep in memory for repeated tool calls. Defaults to 6. */
  cacheSize?: number;
  now?: () => Date;
};

export type IngestInput = { name: string; mimeType?: string; bytes: Uint8Array };

export type LargeFiles = ReturnType<typeof createLargeFiles>;

export function isDocumentId(value: unknown): value is string {
  return typeof value === "string" && DOCUMENT_ID_PATTERN.test(value);
}

export function createLargeFiles(options: LargeFilesOptions) {
  const budget: Budget = { ...DEFAULT_BUDGET, ...options.budget };
  const ttlMs = options.ttlMs ?? 72 * 60 * 60 * 1000;
  const maxUploadBytes = options.maxUploadBytes ?? 100 * 1024 * 1024;
  const now = options.now ?? (() => new Date());
  const cacheSize = Math.max(1, options.cacheSize ?? 6);
  const cache = new Map<string, SearchableDocument>();

  async function load(id: string): Promise<SearchableDocument | undefined> {
    const cached = cache.get(id);
    if (cached) {
      if (Date.parse(cached.meta.expiresAt) > now().getTime()) {
        // Refresh its place as most recently used.
        cache.delete(id);
        cache.set(id, cached);
        return cached;
      }
      cache.delete(id);
    }
    const stored = await options.store.get(id);
    if (!stored) return undefined;
    const document = new SearchableDocument(stored);
    cache.set(id, document);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value!);
    return document;
  }

  return {
    budget,
    maxUploadBytes,

    /** Extracts, normalizes, profiles, and stores a file. Throws with a user-facing message on bad input. */
    async ingest(input: IngestInput): Promise<DocumentMeta> {
      const name = input.name.trim().split(/[\\/]/).at(-1)?.slice(0, 255) || "file";
      const mimeType = input.mimeType?.trim() || "application/octet-stream";
      if (input.bytes.byteLength === 0) throw new Error(`${name} is empty.`);
      if (input.bytes.byteLength > maxUploadBytes) {
        throw new Error(`${name} is larger than the ${Math.round(maxUploadBytes / 1024 / 1024)} MB upload limit.`);
      }
      let format = detectFormat(name, mimeType);
      const extracted = await extractText(input.bytes, { name, mimeType, format }, options.extractors);
      const { text, wrapped } = wrapLongLines(normalizeText(extracted.text));
      if (!text.trim()) throw new Error(`${name} did not contain any text.`);
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      if (format === "text" && looksLikeLog(lines)) format = "log";
      const created = now();
      const meta: DocumentMeta = {
        id: `doc_${randomUUID().replaceAll("-", "")}`,
        name,
        mimeType,
        format,
        bytes: input.bytes.byteLength,
        textBytes: utf8Bytes(text),
        characters: text.length,
        lines: lines.length,
        estimatedTokens: estimateTokens(text),
        wrappedLines: wrapped,
        ...(extracted.pages ? { pages: extracted.pages } : {}),
        outline: buildOutline(lines, format),
        ...(format === "log" ? { logProfile: buildLogProfile(lines) } : {}),
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
      };
      await options.store.put({ meta, text });
      return meta;
    },

    async getMeta(id: string): Promise<DocumentMeta | undefined> {
      return isDocumentId(id) ? options.store.getMeta(id) : undefined;
    },

    async delete(id: string): Promise<boolean> {
      cache.delete(id);
      return isDocumentId(id) ? options.store.delete(id) : false;
    },

    async sweep(): Promise<number> {
      return options.store.sweep?.(now()) ?? 0;
    },

    /**
     * Plans one model request: which documents fit in full and which become searchable cards.
     * `base` is the size of everything else in the request (messages, system prompt, other files).
     */
    async prepare(ids: string[], base: { tokens: number; bytes: number }): Promise<PreparedContext> {
      const unique = [...new Set(ids)];
      const documents: SearchableDocument[] = [];
      const missing: string[] = [];
      for (const id of unique) {
        const document = isDocumentId(id) ? await load(id) : undefined;
        if (document) documents.push(document);
        else missing.push(id);
      }
      const plan = planDocuments(documents.map((document) => document.meta), budget, base);
      const inline = new Set(plan.inline.map((meta) => meta.id));
      const blocks = new Map<string, string>();
      for (const document of documents) {
        blocks.set(document.meta.id, inline.has(document.meta.id) ? renderInline(document) : renderCard(document));
      }
      return { plan, blocks, instruction: documentToolsInstruction(plan.searchable), missing };
    },

    /** Tools scoped to the given documents. Pass `generate` to enable whole-document analysis. */
    tools(documents: DocumentMeta[], toolOptions: { generate?: GenerateText; onProgress?: ProgressListener; signal?: AbortSignal } = {}): ToolSet {
      return createDocumentTools({
        load,
        documentIds: documents.map((meta) => meta.id),
        names: Object.fromEntries(documents.map((meta) => [meta.id, meta.name])),
        budget,
        ...toolOptions,
      });
    },
  };
}
