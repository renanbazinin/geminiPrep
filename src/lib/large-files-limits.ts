import type { LargeFilesConfig, LargeFilesOverrides } from "../../shared/contracts";
import { MAX_ATTACHMENT_BYTES } from "./attachment-limits";

const KB = 1024;
const MB = 1024 * 1024;

/** The lowest token threshold a user may set: below it, almost every file would be searched. */
export const MIN_INLINE_TOKENS = 1_000;
/** The lowest size threshold for text, DOCX and PPTX, in KB. */
export const MIN_SERVER_THRESHOLD_KB = 1;

/** The bounds of each threshold, as Settings shows them: from the floor up to what the server allows. */
export type LargeFilesBounds = {
  serverThresholdKb: { min: number; max: number; server: number };
  pdfInlineMaxMb: { min: number; max: number; server: number };
  inlineTokens: { min: number; max: number; server: number };
};

/**
 * What a user may set. Raising a threshold keeps more in the browser and sends more text whole, so
 * each is capped where the server stops accepting it:
 * - text, DOCX and PPTX size: what this browser keeps of one file (20 MB), and the server's upload
 *   limit (a larger file could go nowhere);
 * - PDF size: the server's own value, which leaves room in a request for the base64 of the PDF;
 * - tokens: the server's own value, the most text it sends in full (more could overflow the model).
 */
export function largeFilesBounds(config: LargeFilesConfig): LargeFilesBounds {
  return {
    serverThresholdKb: {
      min: MIN_SERVER_THRESHOLD_KB,
      max: Math.floor(Math.min(MAX_ATTACHMENT_BYTES, config.maxUploadBytes) / KB),
      server: Math.round(config.serverThresholdBytes / KB),
    },
    pdfInlineMaxMb: { min: 0, max: config.pdfInlineMaxBytes / MB, server: config.pdfInlineMaxBytes / MB },
    inlineTokens: { min: Math.min(MIN_INLINE_TOKENS, config.inlineTokens), max: config.inlineTokens, server: config.inlineTokens },
  };
}

const within = (value: number, bounds: { min: number; max: number }) => Math.min(bounds.max, Math.max(bounds.min, value));
const given = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * The limits the browser routes attachments with: the server's, with the user's thresholds
 * (Settings) in their place, each kept within `largeFilesBounds`.
 */
export function effectiveLargeFilesLimits(config: LargeFilesConfig, overrides: LargeFilesOverrides | undefined): LargeFilesConfig {
  if (!overrides) return config;
  const bounds = largeFilesBounds(config);
  return {
    ...config,
    ...(given(overrides.serverThresholdKb) ? { serverThresholdBytes: Math.round(within(overrides.serverThresholdKb, bounds.serverThresholdKb) * KB) } : {}),
    ...(given(overrides.pdfInlineMaxMb) ? { pdfInlineMaxBytes: Math.round(within(overrides.pdfInlineMaxMb, bounds.pdfInlineMaxMb) * MB) } : {}),
    ...(given(overrides.inlineTokens) ? { inlineTokens: Math.round(within(overrides.inlineTokens, bounds.inlineTokens)) } : {}),
  };
}

/**
 * The token threshold to send with a question (`ChatStreamRequest.largeFilesInlineTokens`): the
 * user's, when it is below the server's, so the server's plan agrees with the browser's routing.
 * Undefined when the server's own value applies, or the server cannot use one (original engine).
 */
export function requestInlineTokens(config: LargeFilesConfig | undefined, overrides: LargeFilesOverrides | undefined): number | undefined {
  if (!config || config.engine !== "npm" || !given(overrides?.inlineTokens)) return undefined;
  const value = effectiveLargeFilesLimits(config, overrides).inlineTokens;
  return value < config.inlineTokens ? value : undefined;
}
