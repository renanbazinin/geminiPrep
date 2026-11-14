// The models slotdeck works with: a text model that answers in JSON, and a source of photos.
// Both follow the provider picked in the chat, with the server's own credentials.
import { gemini, geminiImages, vertexEndpoint, type ImageProvider, type LlmProvider } from "slotdeck";
import type { ProviderId } from "../../shared/contracts.js";
import { IMAGE_MODEL_ID, IMAGE_MODEL_REGION } from "../../shared/chat-tools.js";
import { IMAGE_ASPECT_RATIOS } from "../../shared/interactions.js";
import { vertexGenerateContentUrl } from "../region-probe.js";
import { getVertexAccessToken } from "../vertex-auth.js";
import { resolvePresentationSettings, type PresentationSettings } from "./config.js";

/** The supported output ratio closest to a frame, compared on a log scale (2:1 and 1:2 are equally far from 1:1). */
export function nearestAspectRatio(ratio: number): string {
  let best = "1:1";
  let distance = Infinity;
  for (const candidate of IMAGE_ASPECT_RATIOS) {
    const [width, height] = candidate.split(":").map(Number) as [number, number];
    const next = Math.abs(Math.log(ratio) - Math.log(width / height));
    if (next < distance) {
      best = candidate;
      distance = next;
    }
  }
  return best;
}

/**
 * Photos from Vertex AI. slotdeck's own image adapter calls the Interactions API, which on
 * Vertex does not serve the image model ("not supported by the Interactions API", checked in
 * November 2026), so this one calls Generate Content, like the chat's image tool.
 */
export function vertexImages(options: {
  project: string;
  model?: string;
  imageSize?: string;
  style?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): ImageProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = vertexGenerateContentUrl({ project: options.project, region: IMAGE_MODEL_REGION, model: options.model ?? IMAGE_MODEL_ID });
  return {
    async generateImage(request) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getVertexAccessToken()}` },
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: options.style ? `${request.prompt}\n\n${options.style}` : request.prompt }] }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: nearestAspectRatio(request.aspectRatio), imageSize: options.imageSize ?? "1K" },
          },
        }),
      });
      const data = await response.json().catch(() => null) as {
        error?: { message?: string };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { data?: unknown } }> } }>;
      } | null;
      if (!response.ok) throw new Error(data?.error?.message ?? `The image model returned HTTP ${response.status}.`);
      const candidate = data?.candidates?.[0];
      const image = candidate?.content?.parts?.find((part) => typeof part.inlineData?.data === "string" && part.inlineData.data);
      if (!image) throw new Error(`The image model returned no picture${candidate?.finishReason ? ` (${candidate.finishReason})` : ""}.`);
      return new Uint8Array(Buffer.from(image.inlineData!.data as string, "base64"));
    },
  };
}

/**
 * The text model and photo source for one request. The text model is the one picked in the
 * chat unless PRESENTATIONS_MODEL names another. On Vertex AI it is reached through the
 * Interactions API, which has only the global endpoint: the chat's region does not apply.
 */
export function presentationModels(options: {
  provider: ProviderId;
  model: string;
  project: string | null;
  fetchImpl?: typeof fetch;
  settings?: PresentationSettings;
}): { llm: LlmProvider; images?: ImageProvider; model: string } {
  const settings = options.settings ?? resolvePresentationSettings();
  const model = settings.model ?? options.model;
  const custom = options.fetchImpl ? { fetch: options.fetchImpl } : {};
  const thinking = settings.thinkingLevel ? { thinkingLevel: settings.thinkingLevel } : {};
  if (options.provider === "vertex") {
    if (!options.project) throw new Error("No Google Cloud project is configured for Vertex AI.");
    const project = options.project;
    return {
      model,
      llm: gemini({
        model,
        endpoint: vertexEndpoint(project),
        headers: async () => ({ Authorization: `Bearer ${await getVertexAccessToken()}` }),
        ...thinking,
        ...custom,
      }),
      ...(settings.photos ? {
        images: vertexImages({ project, imageSize: settings.imageSize, style: settings.imageStyle, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) }),
      } : {}),
    };
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");
  return {
    model,
    llm: gemini({ model, apiKey, ...thinking, ...custom }),
    ...(settings.photos ? {
      images: geminiImages({ model: IMAGE_MODEL_ID, apiKey, imageSize: settings.imageSize, style: settings.imageStyle, ...custom }),
    } : {}),
  };
}
