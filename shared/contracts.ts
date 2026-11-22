import type { AskEvent, EventResult, Evidence, ToolOutcome, UsageTotals } from "llm-large-files";
export type ProviderId = "vertex" | "gemini";
export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "stopped" | "error";
export type ChatToolId = "image" | "graph" | "presentation";
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

/** A large file kept on the server, which plans whether the model reads it in full or with tools. */
export type ServerDocumentInfo = {
  id: string;
  format: string;
  lines: number;
  estimatedTokens: number;
  pages?: number;
  expiresAt: string;
  /** The older encoding a text file was read in, when it was not UTF-8 ("windows-1255"…). */
  encoding?: string;
  /** Characters of the file that could not be read in that encoding, and show as U+FFFD. */
  replacedCharacters?: number;
};

export type ChatAttachment = {
  id: string;
  storageKey: string;
  name: string;
  mimeType: string;
  size: number;
  kind: ChatAttachmentKind;
  extractedCharacters?: number;
  /** Set when the file was uploaded to the server instead of stored in this browser. */
  document?: ServerDocumentInfo;
};

/** POST /api/documents response. */
export type DocumentUploadResult = ServerDocumentInfo & {
  name: string;
  mimeType: string;
  bytes: number;
};

/** Limits the browser uses to decide which attachments go to the server. */
export type LargeFilesConfig = {
  maxUploadBytes: number;
  /** Text, DOCX, and PPTX files above this size (or extracted length) are uploaded. */
  serverThresholdBytes: number;
  /**
   * Text, DOCX, and PPTX files whose text is estimated at more tokens than this are uploaded too,
   * whatever their size. It is the most tokens of file text the server sends in full, so a file
   * the browser keeps is one the server would not have searched with tools either.
   */
  inlineTokens: number;
  /** PDFs up to this size are sent inline so Gemini can read their layout and images. */
  pdfInlineMaxBytes: number;
  ttlHours: number;
  /**
   * The large-file engine in use. Absent from older servers. The token threshold of Settings
   * reaches the server's plan, and the steps come as typed events, only with "npm".
   */
  engine?: "npm" | "original";
};

/**
 * The user's own thresholds for large files (Settings). Each one unset (or null) is the server's
 * value; a value is kept within what the server allows (see `effectiveLargeFilesLimits`).
 */
export type LargeFilesOverrides = {
  /** Text, DOCX and PPTX files above this many KB go to the server. */
  serverThresholdKb?: number | null;
  /** PDFs above this many MB go to the server; smaller ones are sent inline. */
  pdfInlineMaxMb?: number | null;
  /** Files whose text is estimated at more tokens than this go to the server, and are searched there. */
  inlineTokens?: number | null;
};

/**
 * An event of the large-file library (llm-large-files) as the server forwards it, for a question
 * with files on the server (npm engine). Left out: `text` (the answer comes in `delta`). The
 * result of `run.finish` and the partial result of `run.error` hold only what the page shows.
 */
export type LargeFilesEvent =
  | Exclude<AskEvent, { type: "text" } | { type: "run.finish" } | { type: "run.error" }>
  | (Omit<Extract<AskEvent, { type: "run.finish" }>, "result"> & { result: LargeFilesFinish })
  | (Omit<Extract<AskEvent, { type: "run.error" }>, "partial"> & { partial?: Pick<EventResult, "steps" | "evidence" | "usage"> });

/** What `run.finish` carries to the page. */
export type LargeFilesFinish = Pick<EventResult, "answered" | "finishReason" | "blockReason" | "steps" | "evidence" | "turns" | "usage">;

/** A tool call of the large-file library, as a message keeps it. */
export type LargeFilesToolCall = {
  callId: string;
  tool: string;
  /** One line of plain text: "Search app.log (exact) for “timeout”". */
  label: string;
  documentId?: string;
  /** Set when the call ended. */
  outcome?: ToolOutcome;
  ms?: number;
  /** The finished step, as the steps list shows it. */
  step?: string;
  /** The latest progress of a whole-file read. */
  progress?: { stage: "map" | "reduce"; done: number; total: number; message: string };
  /** Model requests of this call (a whole-file read) that failed and were sent again. */
  retries?: number;
  /** What the call showed the model: the lines or pages of the document. */
  evidence?: Evidence;
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
    }
  | {
      /** A reference to a server-side document; the server replaces it before calling the model. */
      kind: "document";
      name: string;
      mimeType: string;
      documentId: string;
    };

export type ChatGeneratedImage = {
  id: string;
  storageKey: string;
  mimeType: ChatImageMimeType;
};

/**
 * What a presentation tool made in a turn: a plan to approve, or a rendered deck. The plan,
 * the deck and its pictures stay on the server; the browser keeps this summary.
 */
export type ChatPresentationCard = {
  /** The plan or deck id the tools know it by. */
  id: string;
  templateId: string;
  templateName: string;
  title: string;
  /** One sentence from the tool on what an edit changed. */
  summary?: string;
  /**
   * The tool's result as the chat model saw it. It is sent back as a note with this message's
   * text on later turns, which is how the model knows the id to create or change.
   */
  context: string;
} & (
  | {
      kind: "plan";
      language?: string;
      slides: Array<{ number: number; layout: string; purpose: string }>;
    }
  | {
      kind: "deck";
      slides: Array<{ number: number; layout: string; title?: string }>;
      /** Where the pptx is downloaded from. */
      file: string;
      bytes: number;
      warnings?: string[];
    }
);

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
  /** Steps the model took on large files, or with the presentation tools, while answering. */
  steps?: string[];
  /** The tool calls of the large-file library for this answer, in order (npm engine). */
  largeFileCalls?: LargeFilesToolCall[];
  /** What the library said about the answer outside its steps: a limit reached, no room, a refused prompt. */
  largeFileNotes?: string[];
  /** Requests and tokens of the whole question: every model request, the explorer's and whole-file reads' included. */
  largeFileUsage?: UsageTotals;
  /** Plans and decks the presentation tools made in this turn. */
  presentations?: ChatPresentationCard[];
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
  /** When on, chat uses the Gemini 4 Pro model instead of `models[provider]`. */
  proModel: boolean;
  region: string;
  systemInstruction: string;
  temperature: number;
  maxOutputTokens: number;
  thinkingLevel: ThinkingLevel;
  /** When on, chat auto-creates a billable Vertex cache from the conversation's files. */
  cacheEnabled: boolean;
  cacheTtlSeconds: number;
  /** The template the presentation tools use, chosen in PPTX Studio. Unset: the server's default. */
  presentationTemplate?: string;
  /** Thresholds for large files. Unset: the server's. */
  largeFiles?: LargeFilesOverrides;
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

/** An npm package the server runs, named in the footer under the app's own version. */
export type LibraryVersion = {
  name: string;
  /** The installed version, from the package's own package.json. */
  version: string;
};

/** What the server runs: its package version and, when known, the commit and when it was deployed. */
export type AppVersion = {
  version: string;
  /** Short commit, from APP_COMMIT (set by the deploy script) or the local checkout. "-dirty" marks files that differed from it. */
  commit?: string;
  /** The commit on GitHub, when package.json names a GitHub repository. */
  commitUrl?: string;
  /** ISO time of the deploy, from APP_DEPLOYED_AT. Absent for local runs. */
  deployedAt?: string;
  /**
   * The npm packages in use that the footer names: llm-large-files, while LARGE_FILES_ENGINE is
   * "npm", and slotdeck. Absent from older servers.
   */
  libraries?: LibraryVersion[];
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
  /** Absent from older servers; the browser then keeps every attachment local. */
  largeFiles?: LargeFilesConfig;
  /** Absent from older servers; the footer then shows no version. */
  version?: AppVersion;
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
  /** Template id for the presentation tools. Unset: the server's default template. */
  presentationTemplate?: string;
  /**
   * The most tokens of file text sent in full, when the user set it lower than the server's
   * (Settings → Large files). The server plans with it (npm engine); above it, files are searched.
   */
  largeFilesInlineTokens?: number;
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
  /** A completed step on a large file, such as a search or a read, kept with the answer. */
  | { event: "step"; data: { text: string } }
  /** What the large-file library does, as typed events (npm engine). Sent beside activity and step. */
  | { event: "largeFiles"; data: LargeFilesEvent }
  | { event: "meta"; data: ChatStreamMeta }
  | { event: "delta"; data: { text: string } }
  | { event: "image"; data: ChatStreamImageData }
  | { event: "tool"; data: ChatStreamToolData }
  /** A plan or deck a presentation tool just made. */
  | { event: "presentation"; data: ChatPresentationCard }
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
