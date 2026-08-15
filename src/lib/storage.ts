import type { AppSettings, Conversation, PublicConfig } from "../../shared/contracts";

const CONVERSATIONS_KEY = "gemini-prep:conversations:v1";
const SETTINGS_KEY = "gemini-prep:settings:v1";

export const FALLBACK_SETTINGS: AppSettings = {
  version: 1,
  provider: "vertex",
  models: { vertex: "gemini-3.7-flash", gemini: "gemini-3.7-flash" },
  region: "global",
  systemInstruction: "",
  temperature: 1,
  maxOutputTokens: 8192,
  thinkingLevel: "high",
  cacheEnabled: false,
  cacheTtlSeconds: 3600,
};

export function createId(): string {
  return crypto.randomUUID();
}

export function createConversation(): Conversation {
  const now = new Date().toISOString();
  return { id: createId(), title: "New conversation", createdAt: now, updatedAt: now, messages: [] };
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Conversation>;
  return typeof candidate.id === "string"
    && typeof candidate.title === "string"
    && typeof candidate.createdAt === "string"
    && typeof candidate.updatedAt === "string"
    && Array.isArray(candidate.messages);
}

export function loadConversations(): Conversation[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CONVERSATIONS_KEY) ?? "null");
    if (Array.isArray(parsed)) {
      const valid = parsed.filter(isConversation);
      if (valid.length > 0) {
        return valid.map((conversation) => ({
          ...conversation,
          messages: conversation.messages.map((message) => (
            message.status === "streaming" ? { ...message, status: "stopped" as const } : message
          )),
        }));
      }
    }
  } catch {
    // Corrupt local data falls back to a clean conversation.
  }
  return [createConversation()];
}

export function saveConversations(conversations: Conversation[]): void {
  localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
}

export function loadSettings(): AppSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<AppSettings> | null;
    if (parsed?.version === 1 && (parsed.provider === "vertex" || parsed.provider === "gemini")) {
      return {
        ...FALLBACK_SETTINGS,
        ...parsed,
        models: { ...FALLBACK_SETTINGS.models, ...parsed.models },
      };
    }
  } catch {
    // Corrupt local data falls back to defaults.
  }
  return FALLBACK_SETTINGS;
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function settingsForConfig(settings: AppSettings, config: PublicConfig): AppSettings {
  const vertexModel = config.providers.vertex.models.some((model) => model.id === settings.models.vertex)
    ? settings.models.vertex
    : config.defaults.vertexModel;
  const geminiModel = config.providers.gemini.models.some((model) => model.id === settings.models.gemini)
    ? settings.models.gemini
    : config.defaults.geminiModel;
  const region = config.regions.some((entry) => entry.id === settings.region)
    ? settings.region
    : config.defaults.region;
  return { ...settings, models: { vertex: vertexModel, gemini: geminiModel }, region };
}

export function conversationTitle(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 48) return compact || "New conversation";
  return `${compact.slice(0, 47).trimEnd()}…`;
}

