export type ProviderId = "vertex" | "gemini";
export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "stopped" | "error";
export type ChatToolId = "image" | "graph";
export type ChatImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type ModelOption = {
  id: string;
  label: string;
  family: string;
};

export type RegionOption = {
  id: string;
  label: string;
  group: string;
};

export type RequestSnapshot = {
  api?: "generateContent" | "interactions";
  provider: ProviderId;
  model: string;
  region?: string;
};

export type DebugHttpExchange = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
};

export type ChatStreamMeta = RequestSnapshot & {
  startedAt: string;
  providerRequest?: DebugHttpExchange;
};

export type ChatStreamDone = {
  interactionProject?: string;
  interactionId?: string;
  interactionStatus?: string;
  finishReason?: string;
  responseId?: string;
  usage?: Record<string, unknown>;
  providerStatus?: number;
  finishedAt?: string;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  chunkCount?: number;
  textCharacters?: number;
};

export type ChatStreamErrorData = {
  code?: "interaction_reference_invalid";
  message: string;
  status?: number;
  finishedAt?: string;
  durationMs?: number;
};

export type ChatMessageDebug = {
  version: 1;
  request: {
    local: DebugHttpExchange;
    provider?: DebugHttpExchange;
  };
  response: {
    status: MessageStatus;
    http?: {
      status: number;
      statusText: string;
      headers: Record<string, string>;
    };
    meta?: ChatStreamMeta;
    done?: ChatStreamDone;
    error?: ChatStreamErrorData;
    events?: ChatStreamEvent[];
    content: string;
    deltaEvents: number;
    receivedCharacters: number;
  };
  timing: {
    clientStartedAt: string;
    responseOpenedAt?: string;
    firstDeltaAt?: string;
    completedAt?: string;
    clientDurationMs?: number;
    clientTimeToFirstDeltaMs?: number;
  };
};

export type ChatAttachmentKind = "text" | "pdf" | "docx" | "pptx";

export type ChatAttachment = {
  id: string;
  storageKey: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ChatAttachmentKind;
  extractedCharacters?: number;
};

export type ChatRequestFilePart =
  | {
      kind: "text";
      name: string;
      mimeType: string;
      text: string;
    }
  | {
      kind: "inlineData";
      name: string;
      mimeType: "application/pdf" | ChatImageMimeType;
      data: string;
    };

export type ChatGeneratedImage = {
  id: string;
  storageKey: string;
  mimeType: ChatImageMimeType;
};

export type ChatStreamRequestMessage = {
  role: MessageRole;
  content: string;
  files?: ChatRequestFilePart[];
};

export type ChatMessage = {
  recoveryNotice?: string;
  sources?: Array<{ title: string; url: string }>;
  searchSuggestions?: string[];
  interaction?: { id: string; model: string; apiVersion: "v1" | "v1beta" | "v1beta1"; project?: string };
  thinkingSummary?: string;
  activity?: string;
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status: MessageStatus;
  request?: RequestSnapshot;
  tool?: ChatToolId;
  attachments?: ChatAttachment[];
  generatedImages?: ChatGeneratedImage[];
  debug?: ChatMessageDebug;
  error?: string;
};

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

/** Gemini 3 reasoning depth. Thinking tokens are billed against maxOutputTokens. */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export type InteractionOptions = {
  apiVersion: "v1" | "v1beta";
  stateful: boolean;
  store: boolean;
  thinkingSummaries: "auto" | "none";
  thinkingLevel: "default" | ThinkingLevel;
  toolChoice: "auto" | "any" | "none" | "validated";
  googleSearch: boolean;
  urlContext: boolean;
  codeExecution: boolean;
  seed: number | null;
  stopSequences: string[];
  topP: number | null;
  responseFormat: "text" | "json";
  responseSchema: string;
  imageAspectRatio: string;
  imageSize: "512" | "1K" | "2K" | "4K";
};

export type AppSettings = {
  vertexApi: "interactions" | "generateContent";
  geminiApi: "interactions" | "generateContent";
  interactions: InteractionOptions;
  version: 1;
  provider: ProviderId;
  models: Record<ProviderId, string>;
  region: string;
  systemInstruction: string;
  temperature: number;
  maxOutputTokens: number;
  thinkingLevel: ThinkingLevel;
  /** When on, chat auto-creates a billable Vertex cache from the conversation's files. */
  cacheEnabled: boolean;
  cacheTtlSeconds: number;
};

/** A cache this browser created, tracked locally so chat can reuse it until it expires. */
export type StoredCacheEntry = {
  name: string;
  displayName?: string;
  model: string;
  region: string;
  /** Fingerprint of the cached material, so identical material reuses one cache. */
  signature: string;
  createdAt: string;
  expireTime: string;
  cachedTokens?: number;
};

export type ProviderConfig = {
  id: ProviderId;
  label: string;
  ready: boolean;
  status: string;
  models: ModelOption[];
};

export type PublicConfig = {
  appName: string;
  project: string | null;
  providers: Record<ProviderId, ProviderConfig>;
  regions: RegionOption[];
  defaults: {
    provider: ProviderId;
    vertexModel: string;
    geminiModel: string;
    region: string;
  };
};

export type ChatStreamRequest = {
  /** Expected server project, used to prevent continuation across project changes. */
  interactionProject?: string;
  interactions?: InteractionOptions;
  previousInteractionId?: string;
  provider: ProviderId;
  model: string;
  region?: string;
  systemInstruction?: string;
  temperature: number;
  maxOutputTokens: number;
  thinkingLevel?: ThinkingLevel;
  tool?: ChatToolId;
  /** Full cachedContents resource name. Its content is prepended by Vertex, so never resend it. */
  cachedContent?: string;
  messages: ChatStreamRequestMessage[];
};

export type ChatStreamImageData = {
  mimeType: ChatImageMimeType;
  data: string;
};

export type ChatStreamToolData = {
  id: ChatToolId;
  name: string;
  args: Record<string, unknown>;
  model?: string;
  region?: string;
};

export type ChatStreamEvent =
  | { event: "grounding"; data: { sources?: Array<{ title: string; url: string }>; searchSuggestions?: string } }
  | { event: "thinking"; data: { text: string } }
  | { event: "activity"; data: { text: string } }
  | { event: "meta"; data: ChatStreamMeta }
  | { event: "delta"; data: { text: string } }
  | { event: "image"; data: ChatStreamImageData }
  | { event: "tool"; data: ChatStreamToolData }
  | { event: "done"; data: ChatStreamDone }
  | { event: "error"; data: ChatStreamErrorData };

export type RegionVerdict =
  | "available"
  | "quota"
  | "unavailable"
  | "denied"
  | "timeout"
  | "error";

export type RegionCell = {
  regionId: string;
  modelId: string;
  verdict: RegionVerdict;
  status: number;
  latencyMs: number;
  message: string;
  url: string;
  retried?: boolean;
};

export type RegionRollup = {
  modelId: string;
  label: string;
  family: string;
  available: string[];
};

export type RegionSummary = {
  cells: number;
  available: number;
  unavailable: number;
  denied: number;
  timeout: number;
  error: number;
};

export type RegionTestConfig = {
  regions: RegionOption[];
  models: ModelOption[];
  defaultRegionIds: string[];
  project: string | null;
  projectSource: "env" | "request" | null;
  needsProject: boolean;
  timeoutMs: number;
  concurrency: number;
};

export type TestLanguage = "en" | "he";

export type CacheExpirationMode = "ttl" | "expireTime";

/** One extra part appended to the cached `contents` alongside the inline study text. */
export type CacheFilePart =
  | { kind: "gcs"; name: string; mimeType: string; fileUri: string }
  | { kind: "inlineData"; name: string; mimeType: string; data: string }
  | { kind: "text"; name: string; mimeType: string; text: string };

export type CacheUsageMetadata = {
  totalTokenCount?: number;
  textCount?: number;
  imageCount?: number;
  videoDurationSeconds?: number;
  audioDurationSeconds?: number;
};

export type CachedContentResource = {
  name: string;
  displayName?: string;
  model: string;
  createTime?: string;
  updateTime?: string;
  expireTime?: string;
  usageMetadata?: CacheUsageMetadata;
  encryptionSpec?: { kmsKeyName?: string };
};

export type CacheTestConfig = {
  project: string | null;
  projectSource: "env" | "request" | null;
  needsProject: boolean;
  models: ModelOption[];
  implicitModels: ModelOption[];
  regions: RegionOption[];
  defaults: {
    model: string;
    implicitModel: string;
    region: string;
    ttlSeconds: number;
  };
  limits: {
    minimumTokensGemini3: number;
    minimumTtlSeconds: number;
    maximumInlineBytes: number;
  };
};

export type CacheCreateRequest = {
  project?: string;
  model: string;
  region: string;
  displayName?: string;
  systemInstruction?: string;
  content?: string;
  files?: CacheFilePart[];
  expirationMode: CacheExpirationMode;
  ttlSeconds?: number;
  expireTime?: string;
  kmsKeyName?: string;
};

export type CacheUseResult = {
  text: string;
  latencyMs: number;
  finishReason?: string;
  responseId?: string;
  usageMetadata?: Record<string, unknown> & { cachedContentTokenCount?: number };
  request: {
    model: string;
    region: string;
    cachedContent: string;
    prompt: string;
  };
};

export type ImplicitCacheCall = {
  question: string;
  text: string;
  latencyMs: number;
  finishReason?: string;
  responseId?: string;
  usageMetadata?: Record<string, unknown> & { cachedContentTokenCount?: number };
};

export type ImplicitCacheProbeResult = {
  model: string;
  region: string;
  prefixCharacters: number;
  calls: ImplicitCacheCall[];
  cachedTokens: number;
  hit: boolean;
};
