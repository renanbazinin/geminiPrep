import path from "node:path";
import cors from "cors";
import express from "express";
import {
  resolveDefaultRegionIds,
  resolveCacheModels,
  resolveProbeModels,
  resolveProbeRegions,
  resolveVertexChatModels,
  resolveGeminiChatModels,
  resolveVertexProject,
} from "./catalog.js";
import { buildPublicConfig } from "./config.js";
import {
  resolveProbeConcurrency,
  resolveProbeTimeoutMs,
  runRegionMatrix,
  selectByIds,
  summarizeMatrix,
} from "./region-probe.js";
import { getVertexAccessToken } from "./vertex-auth.js";
import { proxyChatStream } from "./chat/stream.js";
import { validateChatRequest } from "./chat/validation.js";
import {
  CACHE_DEFAULT_TTL_SECONDS,
  CACHE_MAX_INLINE_BYTES,
  CACHE_MIN_TTL_SECONDS,
  GEMINI_3_MIN_CACHE_TOKENS,
  createContextCache,
  deleteContextCache,
  getContextCache,
  listContextCaches,
  parseCacheName,
  updateContextCacheExpiration,
  useContextCache,
  validateCacheCreateRequest,
} from "./context-cache.js";

export function createApp(options: {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => Promise<string>;
} = {}) {
  const app = express();
  const getCacheAccessToken = options.getAccessToken ?? getVertexAccessToken;
  app.disable("x-powered-by");
  app.use(cors());
  app.use(express.json({ limit: "30mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (_req, res) => res.json(buildPublicConfig()));

  app.post("/api/chat/stream", async (req, res) => {
    let request;
    try {
      request = validateChatRequest(req.body, {
        vertexModels: resolveVertexChatModels(),
        geminiModels: resolveGeminiChatModels(),
        regions: resolveProbeRegions(),
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    const { project } = resolveVertexProject(null);
    const abortController = new AbortController();
    res.on("close", () => abortController.abort());
    try {
      await proxyChatStream({
        request,
        project,
        response: res,
        fetchImpl: options.fetchImpl,
        signal: abortController.signal,
      });
    } catch (error) {
      if (abortController.signal.aborted || res.writableEnded) return;
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      } else {
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
        res.end();
      }
    }
  });

  app.get("/api/tests/regions/config", (_req, res) => {
    const { project, source } = resolveVertexProject(null);
    res.json({
      regions: resolveProbeRegions(),
      models: resolveProbeModels(),
      defaultRegionIds: resolveDefaultRegionIds(),
      project,
      projectSource: source,
      needsProject: project === null,
      timeoutMs: resolveProbeTimeoutMs(),
      concurrency: resolveProbeConcurrency(),
    });
  });

  app.get("/api/tests/cache/config", (_req, res) => {
    const { project, source } = resolveVertexProject(null);
    const models = resolveCacheModels();
    const regions = resolveProbeRegions();
    const preferredRegion = process.env.VERTEX_CACHE_DEFAULT_REGION || "global";
    res.json({
      project,
      projectSource: source,
      needsProject: project === null,
      models,
      regions,
      defaults: {
        model: models.find((model) => model.id === "gemini-3.6-flash")?.id ?? models[0]?.id,
        region: regions.some((region) => region.id === preferredRegion)
          ? preferredRegion
          : regions[0]?.id,
        ttlSeconds: CACHE_DEFAULT_TTL_SECONDS,
      },
      limits: {
        minimumTokensGemini3: GEMINI_3_MIN_CACHE_TOKENS,
        minimumTtlSeconds: CACHE_MIN_TTL_SECONDS,
        maximumInlineBytes: CACHE_MAX_INLINE_BYTES,
      },
    });
  });

  app.post("/api/tests/cache/create", async (req, res) => {
    try {
      const request = validateCacheCreateRequest(req.body, {
        modelIds: resolveCacheModels().map((model) => model.id),
        regionIds: resolveProbeRegions().map((region) => region.id),
      });
      const { project } = resolveVertexProject(request.project);
      if (!project) throw new Error("No Google Cloud project is configured for the cache test.");
      const token = await getCacheAccessToken();
      const resource = await createContextCache({
        token,
        project,
        request,
        fetchImpl: options.fetchImpl,
      });
      res.status(201).json(resource);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tests/cache/list", async (req, res) => {
    try {
      const region = typeof req.body?.region === "string" ? req.body.region : "";
      if (!resolveProbeRegions().some((entry) => entry.id === region)) {
        throw new Error("Choose a configured cache location.");
      }
      const { project } = resolveVertexProject(req.body?.project);
      if (!project) throw new Error("No Google Cloud project is configured for the cache test.");
      const token = await getCacheAccessToken();
      res.json(await listContextCaches({ token, project, region, fetchImpl: options.fetchImpl }));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tests/cache/get", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      parseCacheName(name);
      const token = await getCacheAccessToken();
      res.json(await getContextCache({ token, name, fetchImpl: options.fetchImpl }));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tests/cache/update", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      parseCacheName(name);
      const expirationMode = req.body?.expirationMode;
      if (expirationMode !== "ttl" && expirationMode !== "expireTime") {
        throw new Error("expirationMode must be ttl or expireTime.");
      }
      let ttlSeconds: number | undefined;
      let expireTime: string | undefined;
      if (expirationMode === "ttl") {
        ttlSeconds = Number(req.body?.ttlSeconds);
        if (!Number.isInteger(ttlSeconds) || ttlSeconds < CACHE_MIN_TTL_SECONDS) {
          throw new Error(`TTL must be at least ${CACHE_MIN_TTL_SECONDS} seconds.`);
        }
      } else {
        if (typeof req.body?.expireTime !== "string" || !Number.isFinite(Date.parse(req.body.expireTime))) {
          throw new Error("A valid expireTime is required.");
        }
        if (Date.parse(req.body.expireTime) < Date.now() + CACHE_MIN_TTL_SECONDS * 1000) {
          throw new Error("expireTime must be at least one minute in the future.");
        }
        expireTime = new Date(req.body.expireTime).toISOString();
      }
      const token = await getCacheAccessToken();
      res.json(await updateContextCacheExpiration({
        token,
        name,
        expirationMode,
        ttlSeconds,
        expireTime,
        fetchImpl: options.fetchImpl,
      }));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tests/cache/use", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const parsed = parseCacheName(name);
      const model = typeof req.body?.model === "string" ? req.body.model : "";
      if (!resolveCacheModels().some((entry) => entry.id === model)) {
        throw new Error("Choose a configured Gemini 3 cache model.");
      }
      const region = typeof req.body?.region === "string" ? req.body.region : "";
      if (parsed.region !== region) throw new Error("The request region must match the cache location.");
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
      if (!prompt) throw new Error("A prompt is required to use the cache.");
      if (prompt.length > 100_000) throw new Error("Prompt cannot exceed 100,000 characters.");
      const { project } = resolveVertexProject(req.body?.project);
      if (!project) throw new Error("No Google Cloud project is configured for the cache test.");
      const token = await getCacheAccessToken();
      res.json(await useContextCache({
        token,
        project,
        name,
        model,
        region,
        prompt,
        temperature: Number.isFinite(Number(req.body?.temperature))
          ? Math.min(2, Math.max(0, Number(req.body.temperature)))
          : 0.2,
        maxOutputTokens: Number.isInteger(Number(req.body?.maxOutputTokens))
          ? Math.min(8192, Math.max(1, Number(req.body.maxOutputTokens)))
          : 512,
        fetchImpl: options.fetchImpl,
      }));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tests/cache/delete", async (req, res) => {
    try {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      parseCacheName(name);
      const token = await getCacheAccessToken();
      await deleteContextCache({ token, name, fetchImpl: options.fetchImpl });
      res.json({ deleted: true, name });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tests/regions/run", async (req, res) => {
    const { project, source } = resolveVertexProject(req.body?.project);
    if (!project) {
      res.status(400).json({
        error: "No Google Cloud project: set GCP_PROJECT in .env or provide a project in the test form.",
      });
      return;
    }
    try {
      const token = await getVertexAccessToken();
      const regionCatalog = resolveProbeRegions();
      const modelCatalog = resolveProbeModels();
      const regions = selectByIds(req.body?.regions, regionCatalog, resolveDefaultRegionIds());
      const models = selectByIds(req.body?.models, modelCatalog, modelCatalog.map((model) => model.id));
      const startedAt = Date.now();
      const { cells, rollup } = await runRegionMatrix({
        token,
        project,
        regions,
        models,
        fetchImpl: options.fetchImpl,
      });
      res.json({
        project,
        projectSource: source,
        elapsedMs: Date.now() - startedAt,
        regions,
        models,
        summary: summarizeMatrix(cells),
        rollup,
        cells,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.use("/docs", express.static(path.resolve(process.cwd(), "docs")));
  return app;
}
