import type { AppSettings, InteractionOptions } from "./contracts.js";

export function usesInteractions(settings: AppSettings): boolean {
  return (settings.provider === "vertex" ? settings.vertexApi : settings.geminiApi) === "interactions";
}

export function interactionApiVersion(settings: AppSettings): "v1" | "v1beta" | "v1beta1" {
  return settings.provider === "vertex" ? "v1beta1" : settings.interactions.apiVersion;
}

export const IMAGE_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:8", "8:1", "1:4", "4:1"];

export const DEFAULT_INTERACTIONS: InteractionOptions = {
  apiVersion: "v1", stateful: true, store: true,
  thinkingSummaries: "none", thinkingLevel: "default", toolChoice: "auto",
  googleSearch: false, urlContext: false, codeExecution: false,
  seed: null, stopSequences: [], topP: null,
  responseFormat: "text", responseSchema: "", imageAspectRatio: "1:1", imageSize: "1K",
};

/** Shared strict validation for persisted settings and untrusted HTTP input. */
export function parseInteractionOptions(value: unknown, requireReadyToSend = true): InteractionOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("interactions must be an object.");
  const options = { ...DEFAULT_INTERACTIONS, ...value } as InteractionOptions;
  const choices = {
    apiVersion: ["v1", "v1beta"], thinkingLevel: ["default", "minimal", "low", "medium", "high"],
    thinkingSummaries: ["auto", "none"], toolChoice: ["auto", "any", "none", "validated"],
    responseFormat: ["text", "json"], imageAspectRatio: IMAGE_ASPECT_RATIOS, imageSize: ["512", "1K", "2K", "4K"],
  };
  for (const [key, values] of Object.entries(choices)) {
    if (!values.includes(options[key as keyof InteractionOptions] as string)) throw new Error(`Invalid interactions.${key}.`);
  }
  for (const key of ["stateful", "store", "googleSearch", "urlContext", "codeExecution"] as const) {
    if (typeof options[key] !== "boolean") throw new Error(`interactions.${key} must be a boolean.`);
  }
  if (options.stateful && !options.store) throw new Error("Stateful conversations require interaction storage.");
  if (options.seed !== null && (typeof options.seed !== "number" || !Number.isInteger(options.seed) || options.seed < -2147483648 || options.seed > 2147483647)) {
    throw new Error("Seed must be a signed 32-bit integer or empty.");
  }
  if (options.topP !== null && (typeof options.topP !== "number" || !Number.isFinite(options.topP) || options.topP < 0 || options.topP > 1)) {
    throw new Error("Top P must be between 0 and 1 or empty.");
  }
  if (!Array.isArray(options.stopSequences) || options.stopSequences.length > 5 || options.stopSequences.some((entry) => typeof entry !== "string" || !entry || entry.length > 200)) {
    throw new Error("Use up to 5 nonempty stop sequences of at most 200 characters each.");
  }
  if (typeof options.responseSchema !== "string" || options.responseSchema.length > 20_000) throw new Error("Response schema must be text of at most 20,000 characters.");
  if (requireReadyToSend && options.responseFormat === "json" && options.responseSchema.trim()) {
    let schema: unknown;
    try { schema = JSON.parse(options.responseSchema); } catch { throw new Error("Response schema must be valid JSON."); }
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Response schema must be a JSON object.");
  }
  if (requireReadyToSend && options.toolChoice === "any" && !options.googleSearch && !options.urlContext && !options.codeExecution) {
    throw new Error("Enable at least one tool before requiring tool use.");
  }
  return options;
}
