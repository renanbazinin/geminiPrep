import express, { type ErrorRequestHandler } from "express";
import { createDocumentHandlers } from "llm-large-files/node";
import type { DocumentUploadResult } from "../../shared/contracts.js";
import type { DocumentMeta, LargeFiles } from "../../packages/large-files/src/index.js";
import type { ServerLargeFiles } from "./config.js";

export function toUploadResult(meta: DocumentMeta): DocumentUploadResult {
  return {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    bytes: meta.bytes,
    format: meta.format,
    lines: meta.lines,
    estimatedTokens: meta.estimatedTokens,
    ...(meta.pages ? { pages: meta.pages } : {}),
    expiresAt: meta.expiresAt,
  };
}

function headerText(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Upload, inspect, and delete large files. Mount before `express.json()` so JSON files arrive
 * as raw bytes. The body is the file itself; X-File-Name and X-File-Type describe it.
 */
export function documentRoutes(largeFiles: ServerLargeFiles) {
  return largeFiles.engine === "npm" ? packageRoutes(largeFiles.files) : originalRoutes(largeFiles.files);
}

/** The npm engine: llm-large-files' own handlers, which read the raw body themselves. */
function packageRoutes(files: Extract<ServerLargeFiles, { engine: "npm" }>["files"]) {
  const handlers = createDocumentHandlers(files);
  const router = express.Router();
  router.post("/", (req, res, next) => {
    handlers.upload(req, res).catch(next);
  });
  router.get("/:id", (req, res, next) => {
    handlers.get(req, res, req.params.id).catch(next);
  });
  router.delete("/:id", (req, res, next) => {
    handlers.remove(req, res, req.params.id).catch(next);
  });
  return router;
}

function originalRoutes(largeFiles: LargeFiles) {
  const router = express.Router();

  router.post("/", express.raw({ type: () => true, limit: largeFiles.maxUploadBytes }), async (req, res) => {
    const name = headerText(req.headers["x-file-name"]).trim();
    if (!name) {
      res.status(400).json({ error: "The X-File-Name header is required." });
      return;
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const meta = await largeFiles.ingest({
        name,
        mimeType: headerText(req.headers["x-file-type"]) || undefined,
        bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      });
      res.status(201).json(toUploadResult(meta));
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/:id", async (req, res) => {
    const meta = await largeFiles.getMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "This file is no longer on the server." });
      return;
    }
    res.json(toUploadResult(meta));
  });

  router.delete("/:id", async (req, res) => {
    res.json({ deleted: await largeFiles.delete(req.params.id) });
  });

  const errors: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const status = typeof error?.status === "number" ? error.status : 500;
    const message = status === 413
      ? `The file is larger than the ${Math.round(largeFiles.maxUploadBytes / 1024 / 1024)} MB upload limit.`
      : error instanceof Error ? error.message : "Upload failed.";
    res.status(status).json({ error: message });
  };
  router.use(errors);
  return router;
}
