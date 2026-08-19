import type { ModelOption, RegionOption } from "../shared/contracts.js";
import { IMAGE_MODEL_ID } from "../shared/chat-tools.js";

export { IMAGE_MODEL_ID };

export const VERTEX_REGIONS: RegionOption[] = [
  { id: "global", label: "Global endpoint", group: "global" },
  { id: "eu", label: "EU multi-region", group: "eu" },
  { id: "europe-west1", label: "Belgium", group: "eu" },
  { id: "europe-west2", label: "London", group: "eu" },
  { id: "europe-west3", label: "Frankfurt", group: "eu" },
  { id: "europe-west4", label: "Netherlands", group: "eu" },
  { id: "europe-west6", label: "Zürich", group: "eu" },
  { id: "europe-west8", label: "Milan", group: "eu" },
  { id: "europe-west9", label: "Paris", group: "eu" },
  { id: "europe-north1", label: "Finland", group: "eu" },
  { id: "europe-central2", label: "Warsaw", group: "eu" },
  { id: "europe-southwest1", label: "Madrid", group: "eu" },
  { id: "us", label: "US multi-region", group: "us" },
  { id: "us-central1", label: "Iowa", group: "us" },
  { id: "us-east4", label: "N. Virginia", group: "us" },
  { id: "us-west1", label: "Oregon", group: "us" },
  { id: "asia-northeast1", label: "Tokyo", group: "asia" },
  { id: "asia-southeast1", label: "Singapore", group: "asia" },
  { id: "asia-south1", label: "Mumbai", group: "asia" },
];

export const VERTEX_MODELS: ModelOption[] = [
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", family: "3.x" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", family: "3.x" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", family: "3.x" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", family: "3.x" },
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", family: "3.x" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", family: "3.x" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", family: "3.x" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", family: "2.5" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", family: "2.5" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", family: "2.5" },
];

export const VERTEX_IMAGE_MODELS: ModelOption[] = [
  { id: IMAGE_MODEL_ID, label: "Gemini 3.1 Flash Image", family: "image" },
  { id: "gemini-3.1-flash-lite-image", label: "Gemini 3.1 Flash-Lite Image", family: "image" },
  { id: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image", family: "image" },
];

export const GEMINI_MODELS: ModelOption[] = [
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", family: "3.x" },
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", family: "3.x" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", family: "3.x" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", family: "2.5" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", family: "2.5" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", family: "2.5" },
];

const EXPLICIT_CACHE_MODEL_IDS = [
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
];

export const BUILTIN_DEFAULT_REGION_IDS = VERTEX_REGIONS.filter(
  (region) => region.group === "global" || region.group === "eu",
).map((region) => region.id);

export function envIdList(name: string): string[] | null {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : null;
}

export function inferRegionGroup(id: string): string {
  if (id === "global") return "global";
  if (id === "eu" || id.startsWith("europe-")) return "eu";
  if (id === "us" || id.startsWith("us-")) return "us";
  if (id.startsWith("asia-") || id.startsWith("australia-")) return "asia";
  return "other";
}

export function extendCatalog<T extends { id: string }>(
  ids: string[] | null,
  catalog: T[],
  create: (id: string) => T,
): T[] {
  if (!ids) return catalog;
  const known = new Map(catalog.map((entry) => [entry.id, entry]));
  return ids.map((id) => known.get(id) ?? create(id));
}

export function isImageModelId(id: string): boolean {
  return id.includes("-image");
}

function modelFamily(id: string): string {
  if (isImageModelId(id)) return "image";
  if (id.startsWith("gemini-3")) return "3.x";
  if (id.startsWith("gemini-2")) return "2.5";
  return "other";
}

export function resolveProbeRegions(): RegionOption[] {
  return extendCatalog(envIdList("VERTEX_PROBE_REGIONS"), VERTEX_REGIONS, (id) => ({
    id,
    label: id,
    group: inferRegionGroup(id),
  }));
}

export function resolveProbeModels(): ModelOption[] {
  const catalog = [...VERTEX_MODELS, ...VERTEX_IMAGE_MODELS];
  return extendCatalog(envIdList("VERTEX_PROBE_MODELS"), catalog, (id) => ({
    id,
    label: id,
    family: modelFamily(id),
  }));
}

export function resolveVertexChatModels(): ModelOption[] {
  const ids = envIdList("VERTEX_CHAT_MODELS") ?? envIdList("VERTEX_PROBE_MODELS");
  return extendCatalog(ids, VERTEX_MODELS, (id) => ({ id, label: id, family: modelFamily(id) }));
}

export function resolveGeminiChatModels(): ModelOption[] {
  return extendCatalog(envIdList("GEMINI_CHAT_MODELS"), GEMINI_MODELS, (id) => ({
    id,
    label: id,
    family: modelFamily(id),
  }));
}

export function resolveCacheModels(): ModelOption[] {
  const configured = envIdList("VERTEX_CACHE_MODELS");
  const ids = configured ?? EXPLICIT_CACHE_MODEL_IDS;
  return extendCatalog(ids, VERTEX_MODELS, (id) => ({ id, label: id, family: modelFamily(id) }));
}

export function resolveImplicitCacheModels(): ModelOption[] {
  const seen = new Map<string, ModelOption>();
  for (const model of [...resolveVertexChatModels(), ...resolveCacheModels()]) {
    seen.set(model.id, model);
  }
  return [...seen.values()];
}

export function resolveDefaultRegionIds(): string[] {
  return envIdList("VERTEX_PROBE_DEFAULT_REGIONS")
    ?? envIdList("VERTEX_PROBE_REGIONS")
    ?? BUILTIN_DEFAULT_REGION_IDS;
}

export function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function resolveVertexProject(fromRequest: unknown): {
  project: string | null;
  source: "env" | "request" | null;
} {
  const envProject = process.env.GCP_PROJECT
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCLOUD_PROJECT
    || process.env.GCP_PROJECT_ID
    || "";
  if (envProject.trim()) return { project: envProject.trim(), source: "env" };
  if (typeof fromRequest === "string" && fromRequest.trim()) {
    return { project: fromRequest.trim(), source: "request" };
  }
  return { project: null, source: null };
}
