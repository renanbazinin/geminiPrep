import type { PublicConfig } from "../shared/contracts.js";
import {
  resolveGeminiChatModels,
  resolveProbeRegions,
  resolveVertexChatModels,
  resolveVertexProject,
} from "./catalog.js";

export function buildPublicConfig(): PublicConfig {
  const { project } = resolveVertexProject(null);
  const vertexModels = resolveVertexChatModels();
  const geminiModels = resolveGeminiChatModels();
  const regions = resolveProbeRegions();
  const defaultRegionCandidate = process.env.VERTEX_CHAT_DEFAULT_REGION || "global";
  const defaultRegion = regions.some((region) => region.id === defaultRegionCandidate)
    ? defaultRegionCandidate
    : (regions[0]?.id ?? "global");
  return {
    appName: "Gemini Prep",
    project,
    providers: {
      vertex: {
        id: "vertex",
        label: "Vertex AI",
        ready: Boolean(project),
        status: project
          ? `Project ${project} · Application Default Credentials`
          : "Add GCP_PROJECT and sign in with Application Default Credentials",
        models: vertexModels,
      },
      gemini: {
        id: "gemini",
        label: "Gemini API",
        ready: Boolean(process.env.GEMINI_API_KEY),
        status: process.env.GEMINI_API_KEY
          ? "Server API key configured"
          : "Add GEMINI_API_KEY to the server environment",
        models: geminiModels,
      },
    },
    regions,
    defaults: {
      provider: "vertex",
      vertexModel: vertexModels[0]?.id ?? "gemini-2.5-flash",
      geminiModel: geminiModels[0]?.id ?? "gemini-2.5-flash",
      region: defaultRegion,
    },
  };
}

