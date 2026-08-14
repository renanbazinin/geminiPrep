export type ProviderId = "vertex" | "gemini";
export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "stopped" | "error";

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
      mimeType: "application/pdf";
      data: string;
    };

export type ChatStreamRequestMessage = {
  role: MessageRole;
  content: string;
  files?: ChatRequestFilePart[];
};

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  status: MessageStatus;
  request?: RequestSnapshot;
  attachments?: ChatAttachment[];
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

export type AppSettings = {
  version: 1;
  provider: ProviderId;
  models: Record<ProviderId, string>;
  region: string;
  systemInstruction: string;
  temperature: number;
  maxOutputTokens: number;
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
  provider: ProviderId;
  model: string;
  region?: string;
  systemInstruction?: string;
  temperature: number;
  maxOutputTokens: number;
  messages: ChatStreamRequestMessage[];
};

export type ChatStreamEvent =
  | { event: "meta"; data: ChatStreamMeta }
  | { event: "delta"; data: { text: string } }
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

export type CacheContentMode = "text" | "gcs";
export type CacheExpirationMode = "ttl" | "expireTime";

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
  regions: RegionOption[];
  defaults: {
    model: string;
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
  contentMode: CacheContentMode;
  content?: string;
  gcsUri?: string;
  mimeType?: string;
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
