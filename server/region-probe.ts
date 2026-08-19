import type {
  ModelOption,
  RegionCell,
  RegionOption,
  RegionRollup,
  RegionSummary,
  RegionVerdict,
} from "../shared/contracts.js";
import {
  VERTEX_MODELS,
  VERTEX_REGIONS,
  envPositiveInt,
  isImageModelId,
} from "./catalog.js";

export const VERTEX_PROBE_PROMPT = "ping";
export const VERTEX_PROBE_TIMEOUT_MS = 30_000;
export const VERTEX_PROBE_CONCURRENCY = 8;
export const VERTEX_IMAGE_PROBE_MAX_OUTPUT_TOKENS = 4096;

export function resolveProbeTimeoutMs(): number {
  return envPositiveInt("VERTEX_PROBE_TIMEOUT_MS", VERTEX_PROBE_TIMEOUT_MS);
}

export function resolveProbeConcurrency(): number {
  return envPositiveInt("VERTEX_PROBE_CONCURRENCY", VERTEX_PROBE_CONCURRENCY);
}

export function vertexHost(region: string): string {
  if (region === "global") return "https://aiplatform.googleapis.com";
  if (region === "eu" || region === "us") {
    return `https://aiplatform.${region}.rep.googleapis.com`;
  }
  return `https://${region}-aiplatform.googleapis.com`;
}

export function vertexGenerateContentUrl(target: {
  project: string;
  region: string;
  model: string;
  stream?: boolean;
}): string {
  const operation = target.stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `${vertexHost(target.region)}/v1/projects/${target.project}/locations/${target.region}/publishers/google/models/${target.model}:${operation}`;
}

export function buildVertexProbeBody(
  prompt = VERTEX_PROBE_PROMPT,
  modelId?: string,
): Record<string, unknown> {
  const image = Boolean(modelId && isImageModelId(modelId));
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: image ? VERTEX_IMAGE_PROBE_MAX_OUTPUT_TOKENS : 16,
      temperature: 0,
      ...(image ? { responseModalities: ["TEXT", "IMAGE"] } : {}),
    },
  };
}

export function vertexErrorMessage(json: unknown): string {
  const record = json as { error?: { message?: unknown } } | null;
  const arrayError = Array.isArray(json)
    ? (json[0] as { error?: { message?: unknown } } | undefined)?.error
    : undefined;
  const message = record?.error?.message ?? arrayError?.message;
  return typeof message === "string" && message.length > 0 ? message : "";
}

export function classifyVertexResult(status: number, json: unknown): RegionVerdict {
  if (status >= 200 && status < 300) return "available";
  const message = vertexErrorMessage(json).toLowerCase();
  if (status === 429) return "quota";
  if (status === 401 || status === 403) return "denied";
  if (status === 404) return "unavailable";
  if (status === 400) {
    if (
      message.includes("not found")
      || message.includes("not supported")
      || message.includes("not allowed")
      || message.includes("is not available")
    ) return "unavailable";
  }
  return "error";
}

type FetchLike = typeof fetch;

export async function probeRegionModel(options: {
  token: string;
  project: string;
  region: RegionOption;
  model: ModelOption;
  prompt?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): Promise<RegionCell> {
  const {
    token,
    project,
    region,
    model,
    prompt = VERTEX_PROBE_PROMPT,
    fetchImpl = fetch,
    now = () => Date.now(),
    timeoutMs = VERTEX_PROBE_TIMEOUT_MS,
  } = options;
  const url = vertexGenerateContentUrl({ project, region: region.id, model: model.id });
  const startedAt = now();
  let status = 0;
  let json: unknown = null;
  let transportError: string | null = null;

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(buildVertexProbeBody(prompt, model.id)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    json = await response.json().catch(() => null);
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }

  const timedOut = transportError !== null && /timeout|abort/i.test(transportError);
  const verdict = transportError
    ? timedOut ? "timeout" : "error"
    : classifyVertexResult(status, json);
  return {
    regionId: region.id,
    modelId: model.id,
    verdict,
    status,
    latencyMs: now() - startedAt,
    message: transportError ?? (verdict === "available" ? "" : vertexErrorMessage(json)),
    url,
  };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        const item = items[index];
        if (item !== undefined) results[index] = await worker(item, index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export function selectByIds<T extends { id: string }>(
  ids: unknown,
  catalog: T[],
  fallbackIds: string[],
): T[] {
  const wanted = Array.isArray(ids) && ids.length > 0
    ? new Set(ids.filter((id): id is string => typeof id === "string"))
    : new Set(fallbackIds);
  const selected = catalog.filter((entry) => wanted.has(entry.id));
  return selected.length > 0
    ? selected
    : catalog.filter((entry) => fallbackIds.includes(entry.id));
}

export async function runRegionMatrix(options: {
  token: string;
  project: string;
  regions?: RegionOption[];
  models?: ModelOption[];
  concurrency?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}): Promise<{ cells: RegionCell[]; rollup: RegionRollup[] }> {
  const {
    token,
    project,
    regions = VERTEX_REGIONS,
    models = VERTEX_MODELS,
    concurrency = resolveProbeConcurrency(),
    timeoutMs = resolveProbeTimeoutMs(),
    ...rest
  } = options;
  const pairs = models.flatMap((model) => regions.map((region) => ({ model, region })));
  const cells = await mapWithConcurrency(pairs, concurrency, ({ model, region }) => (
    probeRegionModel({ token, project, model, region, timeoutMs, ...rest })
  ));

  const retryable = cells
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => cell.verdict === "error");
  if (retryable.length > 0) {
    const retried = await mapWithConcurrency(retryable, concurrency, async ({ cell }) => {
      const model = models.find((entry) => entry.id === cell.modelId);
      const region = regions.find((entry) => entry.id === cell.regionId);
      if (!model || !region) return cell;
      return probeRegionModel({ token, project, model, region, timeoutMs, ...rest });
    });
    retryable.forEach(({ index }, retryIndex) => {
      const result = retried[retryIndex];
      if (result) cells[index] = { ...result, retried: true };
    });
  }
  return { cells, rollup: rollupByModel(cells, models, regions) };
}

export function rollupByModel(
  cells: RegionCell[],
  models: ModelOption[],
  regions: RegionOption[],
): RegionRollup[] {
  const order = regions.map((region) => region.id);
  return models.map((model) => ({
    modelId: model.id,
    label: model.label,
    family: model.family,
    available: cells
      .filter((cell) => cell.modelId === model.id
        && (cell.verdict === "available" || cell.verdict === "quota"))
      .map((cell) => cell.regionId)
      .sort((a, b) => order.indexOf(a) - order.indexOf(b)),
  }));
}

export function summarizeMatrix(cells: RegionCell[]): RegionSummary {
  const count = (verdict: RegionVerdict) => cells.filter((cell) => cell.verdict === verdict).length;
  return {
    cells: cells.length,
    available: count("available") + count("quota"),
    unavailable: count("unavailable"),
    denied: count("denied"),
    timeout: count("timeout"),
    error: count("error"),
  };
}
