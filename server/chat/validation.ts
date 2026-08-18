import type {
  ChatImageMimeType,
  ChatRequestFilePart,
  ChatStreamRequest,
  ChatToolId,
  MessageRole,
  ProviderId,
} from "../../shared/contracts.js";
import type { ModelOption, RegionOption } from "../../shared/contracts.js";
import { IMAGE_MODEL_ID, IMAGE_MODEL_REGION, isChatToolId, normalizeImageMimeType } from "../../shared/chat-tools.js";

const MAX_HISTORY_MESSAGES = 200;
const MAX_TOTAL_CHARACTERS = 1_000_000;
const MAX_SYSTEM_CHARACTERS = 20_000;
const MAX_FILES_PER_MESSAGE = 10;
const MAX_FILES_PER_REQUEST = 30;
const MAX_TOTAL_INLINE_DATA_CHARACTERS = 28_000_000;
const CACHED_CONTENT_PATTERN = /^projects\/[A-Za-z0-9._-]+\/locations\/([a-z0-9-]+)\/cachedContents\/[A-Za-z0-9_-]+$/;

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
  let tool: ChatToolId | undefined;
  if (input.tool !== undefined && input.tool !== "") {
    tool = isChatToolId(input.tool) ? input.tool : fail("tool must be image or graph.");
  }

  if (typeof input.model !== "string" || !input.model.trim()) fail("model is required.");
  const models = providerId === "vertex" ? catalogs.vertexModels : catalogs.geminiModels;
  let model = input.model.trim();
  if (tool === "image") {
    model = IMAGE_MODEL_ID;
  } else if (!models.some((candidate) => candidate.id === model)) {
    fail(`Model ${model} is not configured for ${providerId}.`);
  }

  let region: string | undefined;
  if (providerId === "vertex") {
    if (typeof input.region !== "string" || !input.region.trim()) fail("region is required for Vertex AI.");
    if (!catalogs.regions.some((candidate) => candidate.id === input.region)) {
      fail(`Region ${input.region} is not configured.`);
    }
    region = tool === "image" ? IMAGE_MODEL_REGION : input.region;
  }

  const temperature = Number(input.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    fail("temperature must be between 0 and 2.");
  }
  const maxOutputTokens = Number(input.maxOutputTokens);
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65_536) {
    fail("maxOutputTokens must be an integer between 1 and 65536.");
  }

  let thinkingLevel: "low" | "high" | undefined;
  if (tool !== "image" && input.thinkingLevel !== undefined) {
    if (input.thinkingLevel !== "low" && input.thinkingLevel !== "high") {
      fail("thinkingLevel must be low or high.");
    }
    thinkingLevel = input.thinkingLevel;
  }

  let cachedContent: string | undefined;
  if (!tool && input.cachedContent !== undefined && input.cachedContent !== "") {
    if (providerId !== "vertex") fail("cachedContent is only supported on Vertex AI.");
    if (typeof input.cachedContent !== "string" || !CACHED_CONTENT_PATTERN.test(input.cachedContent)) {
      fail("cachedContent must be a cachedContents resource name.");
    }
    const cacheRegion = CACHED_CONTENT_PATTERN.exec(input.cachedContent)?.[1];
    if (cacheRegion !== region) {
      fail(`cachedContent lives in ${cacheRegion}, which does not match the request region ${region}.`);
    }
    cachedContent = input.cachedContent;
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
  let totalFiles = 0;
  let totalInlineDataCharacters = 0;
  const messages = input.messages.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") fail(`messages[${index}] is invalid.`);
    const entry = candidate as Record<string, unknown>;
    if (!isRole(entry.role)) fail(`messages[${index}].role is invalid.`);
    if (typeof entry.content !== "string") fail(`messages[${index}].content is required.`);
    totalCharacters += entry.content.length;
    let files: ChatRequestFilePart[] | undefined;
    if (entry.files !== undefined) {
      if (!Array.isArray(entry.files) || entry.files.length === 0 || entry.files.length > MAX_FILES_PER_MESSAGE) {
        fail(`messages[${index}].files must contain between 1 and ${MAX_FILES_PER_MESSAGE} files.`);
      }
      totalFiles += entry.files.length;
      files = entry.files.map((candidateFile, fileIndex) => {
        if (!candidateFile || typeof candidateFile !== "object") {
          fail(`messages[${index}].files[${fileIndex}] is invalid.`);
        }
        const file = candidateFile as Record<string, unknown>;
        if (typeof file.name !== "string" || !file.name.trim() || file.name.length > 255) {
          fail(`messages[${index}].files[${fileIndex}].name is invalid.`);
        }
        if (typeof file.mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType)) {
          fail(`messages[${index}].files[${fileIndex}].mimeType is invalid.`);
        }
        if (file.kind === "text") {
          if (entry.role !== "user") {
            fail(`messages[${index}].files[${fileIndex}] text parts are only supported for user messages.`);
          }
          if (typeof file.text !== "string" || !file.text.trim()) {
            fail(`messages[${index}].files[${fileIndex}].text is required.`);
          }
          totalCharacters += file.text.length;
          return { kind: "text" as const, name: file.name, mimeType: file.mimeType, text: file.text };
        }
        if (file.kind === "inlineData") {
          const imageMime = normalizeImageMimeType(file.mimeType);
          if (file.mimeType !== "application/pdf" && !imageMime) {
            fail(`messages[${index}].files[${fileIndex}] inlineData must be a PDF or image.`);
          }
          if (file.mimeType === "application/pdf" && entry.role !== "user") {
            fail(`messages[${index}].files[${fileIndex}] PDFs are only supported on user messages.`);
          }
          if (typeof file.data !== "string" || !file.data || file.data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.data)) {
            fail(`messages[${index}].files[${fileIndex}].data must be valid base64.`);
          }
          totalInlineDataCharacters += file.data.length;
          return {
            kind: "inlineData" as const,
            name: file.name,
            mimeType: (imageMime ?? "application/pdf") as "application/pdf" | ChatImageMimeType,
            data: file.data,
          };
        }
        fail(`messages[${index}].files[${fileIndex}].kind is invalid.`);
      });
    }
    if (!entry.content.trim() && !files) fail(`messages[${index}].content is required.`);
    return { role: entry.role, content: entry.content, ...(files ? { files } : {}) };
  });
  if (messages.at(-1)?.role !== "user") fail("The last message must be from the user.");
  if (totalCharacters > MAX_TOTAL_CHARACTERS) {
    fail(`Conversation history cannot exceed ${MAX_TOTAL_CHARACTERS} characters.`);
  }
  if (totalFiles > MAX_FILES_PER_REQUEST) {
    fail(`Conversation history cannot contain more than ${MAX_FILES_PER_REQUEST} files.`);
  }
  if (totalInlineDataCharacters > MAX_TOTAL_INLINE_DATA_CHARACTERS) {
    fail("Inline PDF data in the conversation cannot exceed the local 20 MB request budget.");
  }

  return {
    provider: providerId,
    model,
    ...(region ? { region } : {}),
    ...(systemInstruction ? { systemInstruction } : {}),
    temperature,
    maxOutputTokens,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(tool ? { tool } : {}),
    ...(cachedContent ? { cachedContent } : {}),
    messages,
  };
}
