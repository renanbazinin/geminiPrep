import type { AppSettings, ModelOption } from "./contracts.js";

/**
 * The Pro model behind the chat's "Gemini 4" toggle. Turning the toggle on uses this model
 * without replacing the model saved for each provider, so turning it off restores that choice.
 */
export const PRO_MODEL: ModelOption = { id: "gemini-4-argon", label: "Gemini 4 Argon", family: "4.x" };
export const PRO_MODEL_LABEL = "Gemini 4";

/** Vertex serves Gemini 4 from the global endpoint and the us/eu multi-regions only. */
export const GEMINI_4_VERTEX_REGIONS = ["global", "us", "eu"];

/** Thinking shares max_output_tokens with the answer; Google recommends at least this much. */
export const GEMINI_4_MIN_OUTPUT_TOKENS = 32_768;

export function isGemini4Model(model: string): boolean {
  return model.startsWith("gemini-4");
}

/** The model a chat turn uses: the Pro model while the toggle is on, otherwise the saved model. */
export function chatModelFor(settings: Pick<AppSettings, "proModel" | "provider" | "models">): string {
  return settings.proModel ? PRO_MODEL.id : settings.models[settings.provider];
}

export function gemini4OutputTokens(requested: number): number {
  return Math.max(requested, GEMINI_4_MIN_OUTPUT_TOKENS);
}

/** Gemini 4 rejects "minimal" with HTTP 400. "low" is the nearest level it accepts. */
export function gemini4ThinkingLevel<T extends string>(level: T): T | "low" {
  return level === "minimal" ? "low" : level;
}

/** Why a Vertex region cannot serve Gemini 4, or null when it can. */
export function gemini4RegionProblem(region: string): string | null {
  return GEMINI_4_VERTEX_REGIONS.includes(region)
    ? null
    : `Gemini 4 is not served from ${region}. Choose the global endpoint or the us or eu multi-region in Settings.`;
}
