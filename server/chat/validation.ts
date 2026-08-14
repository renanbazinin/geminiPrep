import type { ChatStreamRequest, MessageRole, ProviderId } from "../../shared/contracts.js";
import type { ModelOption, RegionOption } from "../../shared/contracts.js";

const MAX_HISTORY_MESSAGES = 200;
const MAX_TOTAL_CHARACTERS = 200_000;
const MAX_SYSTEM_CHARACTERS = 20_000;

function isRole(value: unknown): value is MessageRole {
  return value === "user" || value === "assistant";
}

function fail(message: string): never {
  throw new Error(message);
}

export function validateChatRequest(
  body: unknown,
  catalogs: { vertexModels: ModelOption[]; geminiModels: ModelOption[]; regions: RegionOption[] },
): ChatStreamRequest {
  if (!body || typeof body !== "object") fail("A JSON request body is required.");
  const input = body as Record<string, unknown>;
  const provider = input.provider;
  if (provider !== "vertex" && provider !== "gemini") {
    fail("provider must be either vertex or gemini.");
  }
  const providerId: ProviderId = provider;
  if (typeof input.model !== "string" || !input.model.trim()) fail("model is required.");
  const models = providerId === "vertex" ? catalogs.vertexModels : catalogs.geminiModels;
  if (!models.some((model) => model.id === input.model)) {
    fail(`Model ${input.model} is not configured for ${providerId}.`);
  }

  let region: string | undefined;
  if (providerId === "vertex") {
    if (typeof input.region !== "string" || !input.region.trim()) fail("region is required for Vertex AI.");
    if (!catalogs.regions.some((candidate) => candidate.id === input.region)) {
      fail(`Region ${input.region} is not configured.`);
    }
    region = input.region;
  }

  const temperature = Number(input.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    fail("temperature must be between 0 and 2.");
  }
  const maxOutputTokens = Number(input.maxOutputTokens);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65_536) {
    fail("maxOutputTokens must be an integer between 1 and 65536.");
  }

  const systemInstruction = typeof input.systemInstruction === "string"
    ? input.systemInstruction.trim()
    : "";
  if (systemInstruction.length > MAX_SYSTEM_CHARACTERS) {
    fail(`systemInstruction cannot exceed ${MAX_SYSTEM_CHARACTERS} characters.`);
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    fail("messages must contain at least one message.");
  }
  if (input.messages.length > MAX_HISTORY_MESSAGES) {
    fail(`messages cannot contain more than ${MAX_HISTORY_MESSAGES} entries.`);
  }

  let totalCharacters = 0;
  const messages = input.messages.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") fail(`messages[${index}] is invalid.`);
    const entry = candidate as Record<string, unknown>;
    if (!isRole(entry.role)) fail(`messages[${index}].role is invalid.`);
    if (typeof entry.content !== "string" || !entry.content.trim()) {
      fail(`messages[${index}].content is required.`);
    }
    totalCharacters += entry.content.length;
    return { role: entry.role, content: entry.content };
  });
  if (messages.at(-1)?.role !== "user") fail("The last message must be from the user.");
  if (totalCharacters > MAX_TOTAL_CHARACTERS) {
    fail(`Conversation history cannot exceed ${MAX_TOTAL_CHARACTERS} characters.`);
  }

  return {
    provider: providerId,
    model: input.model,
    ...(region ? { region } : {}),
    ...(systemInstruction ? { systemInstruction } : {}),
    temperature,
    maxOutputTokens,
    messages,
  };
}

