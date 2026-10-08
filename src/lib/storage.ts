import type { AppSettings, Conversation, PublicConfig } from "../../shared/contracts";
import { DEFAULT_INTERACTIONS, parseInteractionOptions } from "../../shared/interactions";

const CONVERSATIONS_KEY = "gemini-prep:conversations:v1";
const SETTINGS_KEY = "gemini-prep:settings:v1";
const ACTIVE_CONVERSATION_KEY = "gemini-prep:active-conversation:v1";

export function loadActiveConversationId(conversations: Conversation[]): string {
  try {
    const saved = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
    if (conversations.some((conversation) => conversation.id === saved)) return saved!;
  } catch { /* Browsers can deny access to local storage. */ }
  return conversations[0]!.id;
}

export function saveActiveConversationId(id: string): void {
  localStorage.setItem(ACTIVE_CONVERSATION_KEY, id);
}

export const FALLBACK_SETTINGS: AppSettings = {
  vertexApi: "generateContent",
  geminiApi: "interactions",
  interactions: DEFAULT_INTERACTIONS,
  version: 1,
  provider: "gemini",
  models: { vertex: "gemini-3.8-flash", gemini: "gemini-3.8-flash" },
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
        geminiApi: parsed.geminiApi === "generateContent" ? "generateContent" : "interactions",
        vertexApi: parsed.vertexApi === "interactions" ? "interactions" : "generateContent",
        interactions: restoreInteractionSettings(parsed.interactions),
      };
    }
  } catch {
    // Corrupt local data falls back to defaults.
  }
  return FALLBACK_SETTINGS;
}

function restoreInteractionSettings(value: unknown) {
  // Preserve unfinished schema drafts across navigation/reload; sending still validates them.
  try { return parseInteractionOptions(value ?? DEFAULT_INTERACTIONS, false); }
  catch {
    const saved = value && typeof value === "object" ? value as Record<string, unknown> : {};
    // A corrupt unrelated preference must never undo the user's storage opt-out.
    const store = saved.store !== false;
    return { ...DEFAULT_INTERACTIONS, store, stateful: store && saved.stateful !== false };
  }
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

