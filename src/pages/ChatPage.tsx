import {
  ArrowUp,
  Check,
  Copy,
  Database,
  Download,
  FileJson,
  FileText,
  FileType2,
  Image as ImageIcon,
  LoaderCircle,
  Paperclip,
  Presentation,
  RotateCcw,
  Settings2,
  Share2,
  Sparkles,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import type {
  ChatMessage,
  ChatMessageDebug,
  ChatAttachment,
  ChatGeneratedImage,
  ChatStreamErrorData,
  ChatStreamRequest,
  ChatToolId,
} from "../../shared/contracts";
import { IMAGE_MODEL_ID, IMAGE_MODEL_REGION } from "../../shared/chat-tools";
import { compactDebugValue } from "../../shared/debug";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { MessageDebugBubble } from "../components/MessageDebugBubble";
import { useApp } from "../contexts/AppContext";
import { useConfig } from "../contexts/ConfigContext";
import { streamChat } from "../lib/api";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  attachmentToRequestPart,
  deleteAttachmentPayloads,
  processAttachment,
} from "../lib/attachments";
import {
  deleteGeneratedImages,
  generatedImageFilename,
  generatedImageObjectUrl,
  generatedImageToRequestPart,
  storeGeneratedImage,
} from "../lib/generated-images";
import { createId } from "../lib/storage";

const SUGGESTIONS = [
  "Explain how Vertex AI regional endpoints differ from the global endpoint.",
  "Help me design a safe model rollout checklist for an enterprise chatbot.",
  "Compare Gemini Flash and Pro for a customer-support assistant.",
];

function directionFor(text: string): "rtl" | "ltr" {
  return /[\u0590-\u08ff]/.test(text) ? "rtl" : "ltr";
}

async function messageHistory(messages: ChatMessage[]): Promise<ChatStreamRequest["messages"]> {
  return Promise.all(messages
    .filter((message) => message.status !== "error" && (
      Boolean(message.content.trim())
      || Boolean(message.attachments?.length)
      || Boolean(message.generatedImages?.length)
    ))
    .map(async (message) => {
      const files = [
        ...(message.attachments?.length
          ? await Promise.all(message.attachments.map(attachmentToRequestPart))
          : []),
        ...(message.generatedImages?.length
          ? await Promise.all(message.generatedImages.map(generatedImageToRequestPart))
          : []),
      ];
      return {
        role: message.role,
        content: message.content,
        ...(files.length ? { files } : {}),
      };
    }));
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function AttachmentIcon({ attachment, size = 15 }: { attachment: ChatAttachment; size?: number }) {
  if (attachment.kind === "pptx") return <Presentation size={size} />;
  if (attachment.kind === "docx") return <FileType2 size={size} />;
  if (attachment.name.toLowerCase().endsWith(".json")) return <FileJson size={size} />;
  return <FileText size={size} />;
}

function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className="message-attachments" aria-label="Attached files">
      {attachments.map((attachment) => (
        <div className="message-attachment" key={attachment.id} title={attachment.name}>
          <span><AttachmentIcon attachment={attachment} /></span>
          <div><strong>{attachment.name}</strong><small>{attachment.kind.toUpperCase()} · {fileSize(attachment.size)}</small></div>
        </div>
      ))}
    </div>
  );
}

function GeneratedImageCard({ image }: { image: ChatGeneratedImage }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    void generatedImageObjectUrl(image).then((next) => {
      if (cancelled) {
        if (next) URL.revokeObjectURL(next);
        return;
      }
      objectUrl = next;
      setUrl(next);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.storageKey]);
  if (!url) return <div className="generated-image generated-image-pending">Loading image…</div>;
  return (
    <figure className="generated-image">
      <img src={url} alt="Generated" />
      <a className="generated-image-download" href={url} download={generatedImageFilename(image)}>
        <Download size={14} />
        Download
      </a>
    </figure>
  );
}

function ComposerTools({
  selected,
  onSelect,
  disabled,
}: {
  selected: ChatToolId | null;
  onSelect(tool: ChatToolId | null): void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const Icon = selected === "image" ? ImageIcon : selected === "graph" ? Share2 : Wrench;
  const title = selected === "image" ? "Generate image" : selected === "graph" ? "Generate graph" : "Tools (Auto)";
  return (
    <div className="composer-tools" ref={wrapRef}>
      <button
        type="button"
        className={`tool-button${selected ? " tool-button-active" : ""}`}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon size={18} />
      </button>
      {open ? (
        <div className="composer-tools-menu" role="menu">
          {([
            ["image", "Generate image", ImageIcon],
            ["graph", "Generate graph", Share2],
          ] as const).map(([id, label, ItemIcon]) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={selected === id}
              className={selected === id ? "is-selected" : undefined}
              onClick={() => {
                onSelect(selected === id ? null : id);
                setOpen(false);
              }}
            >
              <ItemIcon size={16} />
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function composerPlaceholder(tool: ChatToolId | null, hasAttachments: boolean): string {
  if (tool === "image") return "Describe the image…";
  if (tool === "graph") return "Describe the diagram…";
  if (hasAttachments) return "Ask about these files…";
  return "Message Gemini Prep…";
}

function initialDebugTrace(request: ChatStreamRequest, startedAt: string): ChatMessageDebug {
  return {
    version: 1,
    request: {
      local: {
        method: "POST",
        url: "/api/chat/stream",
        headers: { "Content-Type": "application/json" },
        body: compactDebugValue(request, { maxStringCharacters: 4_000, maxArrayItems: 40 }),
      },
    },
    response: {
      status: "streaming",
      events: [],
      content: "",
      deltaEvents: 0,
      receivedCharacters: 0,
    },
    timing: { clientStartedAt: startedAt },
  };
}

function ProviderBadge() {
  const { settings } = useApp();
  const { config } = useConfig();
  const model = settings.models[settings.provider];
  return (
    <Link className="provider-badge" to="/settings" title="Open model settings">
      <span className={`provider-dot provider-dot-${settings.provider}`} />
      <span>{settings.provider === "vertex" ? "Vertex AI" : "Gemini API"}</span>
      <span className="provider-model">{model}</span>
      {settings.provider === "vertex" ? <span className="provider-region">{settings.region}</span> : null}
      {!config?.providers[settings.provider].ready ? <span className="provider-warning">Setup needed</span> : null}
      <Settings2 size={14} />
    </Link>
  );
}

function MessageActions({
  message,
  allowRetry,
  onRetry,
}: {
  message: ChatMessage;
  allowRetry: boolean;
  onRetry(): void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }
  return (
    <div className="message-actions">
      {message.content ? (
        <button onClick={() => void copy()} aria-label="Copy response" title="Copy response">
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      ) : null}
      {allowRetry ? (
        <button onClick={onRetry} aria-label="Retry response" title="Retry response">
          <RotateCcw size={15} />
        </button>
      ) : null}
    </div>
  );
}

export function ChatPage() {
  const {
    activeConversation,
    settings,
    appendMessages,
    updateMessage,
    removeMessage,
  } = useApp();
  const { config, loading: configLoading, error: configError } = useConfig();
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [processingFiles, setProcessingFiles] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<ChatToolId | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAttachmentsRef = useRef<ChatAttachment[]>([]);
  const pendingConversationRef = useRef(activeConversation.id);

  const messageCount = activeConversation.messages.length;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeConversation.id, messageCount]);

  useEffect(() => {
    if (pendingConversationRef.current === activeConversation.id) return;
    const stale = pendingAttachmentsRef.current;
    pendingAttachmentsRef.current = [];
    setPendingAttachments([]);
    setAttachmentError(null);
    pendingConversationRef.current = activeConversation.id;
    void deleteAttachmentPayloads(stale).catch(() => undefined);
  }, [activeConversation.id]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const activeModel = settings.models[settings.provider];
  const providerReady = config?.providers[settings.provider].ready ?? false;
  const canSend = (draft.trim().length > 0 || pendingAttachments.length > 0)
    && !running && !preparing && !processingFiles && !configLoading && Boolean(config);

  async function addFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    setAttachmentError(null);
    const files = Array.from(fileList);
    if (pendingAttachments.length + files.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      setAttachmentError(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files to one message.`);
      return;
    }
    const totalBytes = [...pendingAttachments.map((attachment) => attachment.size), ...files.map((file) => file.size)]
      .reduce((sum, size) => sum + size, 0);
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      setAttachmentError(`Attachments in one message cannot exceed ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB combined.`);
      return;
    }
    setProcessingFiles(true);
    const added: ChatAttachment[] = [];
    try {
      for (const file of files) added.push(await processAttachment(file));
      const next = [...pendingAttachmentsRef.current, ...added];
      pendingAttachmentsRef.current = next;
      setPendingAttachments(next);
    } catch (error) {
      await deleteAttachmentPayloads(added).catch(() => undefined);
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setProcessingFiles(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function removePendingAttachment(attachment: ChatAttachment) {
    const next = pendingAttachmentsRef.current.filter((candidate) => candidate.id !== attachment.id);
    pendingAttachmentsRef.current = next;
    setPendingAttachments(next);
    void deleteAttachmentPayloads([attachment]).catch(() => undefined);
  }

  async function run(
    conversationId: string,
    request: ChatStreamRequest,
    assistantId: string,
    initialDebug: ChatMessageDebug,
  ) {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    let assembled = "";
    let generatedImages: ChatGeneratedImage[] = [];
    let debug = initialDebug;
    const clientStartedMs = Date.parse(initialDebug.timing.clientStartedAt);
    function updateDebug(next: ChatMessageDebug, patch: Partial<ChatMessage> = {}) {
      debug = next;
      updateMessage(conversationId, assistantId, { ...patch, debug });
    }
    function finishTiming() {
      const completedAt = new Date().toISOString();
      return {
        ...debug.timing,
        completedAt,
        clientDurationMs: Math.max(0, Date.parse(completedAt) - clientStartedMs),
      };
    }
    try {
      await streamChat(request, {
        onOpen(response) {
          updateDebug({
            ...debug,
            response: { ...debug.response, http: response },
            timing: { ...debug.timing, responseOpenedAt: new Date().toISOString() },
          });
        },
        onMeta(meta) {
          updateDebug({
            ...debug,
            request: { ...debug.request, ...(meta.providerRequest ? { provider: meta.providerRequest } : {}) },
            response: {
              ...debug.response,
              meta,
              events: [...(debug.response.events ?? []), { event: "meta", data: meta }],
            },
          });
        },
        onDelta(text) {
          assembled += text;
          const firstDeltaAt = debug.timing.firstDeltaAt ?? new Date().toISOString();
          updateDebug({
            ...debug,
            response: {
              ...debug.response,
              content: assembled,
              events: [...(debug.response.events ?? []), { event: "delta", data: { text } }],
              deltaEvents: debug.response.deltaEvents + 1,
              receivedCharacters: assembled.length,
            },
            timing: {
              ...debug.timing,
              firstDeltaAt,
              clientTimeToFirstDeltaMs: Math.max(0, Date.parse(firstDeltaAt) - clientStartedMs),
            },
          }, { content: assembled });
        },
        async onImage(image) {
          const stored = await storeGeneratedImage(image);
          generatedImages = [...generatedImages, stored];
          const firstDeltaAt = debug.timing.firstDeltaAt ?? new Date().toISOString();
          updateDebug({
            ...debug,
            response: {
              ...debug.response,
              events: [...(debug.response.events ?? []), {
                event: "image",
                data: { mimeType: image.mimeType, data: `[${image.data.length} base64 characters omitted]` },
              }],
            },
            timing: {
              ...debug.timing,
              firstDeltaAt,
              clientTimeToFirstDeltaMs: Math.max(0, Date.parse(firstDeltaAt) - clientStartedMs),
            },
          }, { generatedImages });
        },
        onTool(toolEvent) {
          const firstDeltaAt = debug.timing.firstDeltaAt ?? new Date().toISOString();
          updateDebug({
            ...debug,
            response: {
              ...debug.response,
              events: [...(debug.response.events ?? []), { event: "tool", data: toolEvent }],
            },
            timing: {
              ...debug.timing,
              firstDeltaAt,
              clientTimeToFirstDeltaMs: Math.max(0, Date.parse(firstDeltaAt) - clientStartedMs),
            },
          }, {
            tool: toolEvent.id,
            request: {
              provider: request.provider,
              model: toolEvent.model ?? request.model,
              ...(toolEvent.region ?? request.region
                ? { region: toolEvent.region ?? request.region }
                : {}),
            },
          });
        },
        onDone(done) {
          updateDebug({
            ...debug,
            response: {
              ...debug.response,
              status: "complete",
              content: assembled,
              done,
              events: [...(debug.response.events ?? []), { event: "done", data: done }],
            },
            timing: finishTiming(),
          }, { status: "complete", content: assembled });
        },
        onError(error) {
          updateDebug({
            ...debug,
            response: {
              ...debug.response,
              status: "error",
              content: assembled,
              error,
              events: [...(debug.response.events ?? []), { event: "error", data: error }],
            },
          });
        },
      }, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        updateDebug({
          ...debug,
          response: { ...debug.response, status: "stopped", content: assembled },
          timing: finishTiming(),
        }, { status: "stopped", content: assembled });
      } else {
        const streamError: ChatStreamErrorData = debug.response.error ?? {
          message: error instanceof Error ? error.message : String(error),
        };
        updateDebug({
          ...debug,
          response: {
            ...debug.response,
            status: "error",
            content: assembled,
            error: streamError,
            events: debug.response.error
              ? debug.response.events
              : [...(debug.response.events ?? []), { event: "error", data: streamError }],
          },
          timing: finishTiming(),
        }, {
          status: "error",
          content: assembled,
          error: streamError.message,
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  }

  function buildStreamRequest(
    messages: ChatStreamRequest["messages"],
    tool: ChatToolId | null,
  ): ChatStreamRequest {
    const image = tool === "image";
    const model = image ? IMAGE_MODEL_ID : activeModel;
    const region = settings.provider === "vertex"
      ? (image ? IMAGE_MODEL_REGION : settings.region)
      : undefined;
    return {
      provider: settings.provider,
      model,
      ...(region ? { region } : {}),
      systemInstruction: settings.systemInstruction,
      temperature: settings.temperature,
      maxOutputTokens: settings.maxOutputTokens,
      ...(!image ? { thinkingLevel: settings.thinkingLevel } : {}),
      ...(tool ? { tool } : {}),
      messages,
    };
  }

  function requestSnapshot(request: ChatStreamRequest) {
    return {
      provider: request.provider,
      model: request.model,
      ...(request.region ? { region: request.region } : {}),
    };
  }

  async function startWithText(text: string) {
    const clean = text.trim() || (pendingAttachments.length > 0 ? "Please analyze the attached files." : "");
    if (!clean || running || preparing || processingFiles || !config) return;
    setPreparing(true);
    setAttachmentError(null);
    const conversationId = activeConversation.id;
    const now = new Date().toISOString();
    const attachments = [...pendingAttachmentsRef.current];
    try {
      const currentHistory = await messageHistory(activeConversation.messages);
      const files = attachments.length
        ? await Promise.all(attachments.map(attachmentToRequestPart))
        : undefined;
      const messages = [...currentHistory, { role: "user" as const, content: clean, ...(files ? { files } : {}) }];
      const tool = selectedTool;
      const request = buildStreamRequest(messages, tool);
      const debug = initialDebugTrace(request, now);
      const userMessage: ChatMessage = {
        id: createId(), role: "user", content: clean, createdAt: now, status: "complete",
        ...(tool ? { tool } : {}),
        ...(attachments.length ? { attachments } : {}),
      };
      const assistantMessage: ChatMessage = {
        id: createId(),
        role: "assistant",
        content: "",
        createdAt: now,
        status: "streaming",
        request: requestSnapshot(request),
        ...(tool ? { tool } : {}),
        debug,
      };
      appendMessages(conversationId, [userMessage, assistantMessage]);
      pendingAttachmentsRef.current = [];
      setPendingAttachments([]);
      setDraft("");
      void run(conversationId, request, assistantMessage.id, debug);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparing(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSend) void startWithText(draft);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) void startWithText(draft);
    }
  }

  async function retryLast(message: ChatMessage) {
    if (running || preparing || !config) return;
    const index = activeConversation.messages.findIndex((candidate) => candidate.id === message.id);
    if (index < 1) return;
    const baseMessages = activeConversation.messages.slice(0, index);
    if (baseMessages.at(-1)?.role !== "user") return;
    setPreparing(true);
    setAttachmentError(null);
    try {
      const messages = await messageHistory(baseMessages);
      const tool = message.tool ?? null;
      const request = buildStreamRequest(messages, tool);
      const startedAt = new Date().toISOString();
      const debug = initialDebugTrace(request, startedAt);
      const assistantMessage: ChatMessage = {
        id: createId(),
        role: "assistant",
        content: "",
        createdAt: startedAt,
        status: "streaming",
        request: requestSnapshot(request),
        ...(tool ? { tool } : {}),
        debug,
      };
      void deleteGeneratedImages(message.generatedImages ?? []).catch(() => undefined);
      removeMessage(activeConversation.id, message.id);
      appendMessages(activeConversation.id, [assistantMessage]);
      void run(activeConversation.id, request, assistantMessage.id, debug);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreparing(false);
    }
  }

  const lastAssistantId = useMemo(
    () => [...activeConversation.messages].reverse().find((message) => message.role === "assistant")?.id,
    [activeConversation.messages],
  );

  return (
    <div className="chat-page">
      <div className="chat-topbar">
        <ProviderBadge />
      </div>

      <div className={`messages${activeConversation.messages.length === 0 ? " messages-empty" : ""}`}>
        {activeConversation.messages.length === 0 ? (
          <section className="chat-empty-state">
            <div className="hero-orb"><Sparkles size={27} /></div>
            <p className="eyebrow">VERTEX-FIRST LEARNING LAB</p>
            <h1>What are you preparing for?</h1>
            <p className="hero-copy">
              Explore a model, plan an enterprise chatbot decision, or test how an endpoint behaves.
              Your conversations stay in this browser.
            </p>
            <div className="suggestion-grid">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} onClick={() => void startWithText(suggestion)} disabled={!config || running || preparing}>
                  {suggestion}
                  <ArrowUp size={15} />
                </button>
              ))}
            </div>
          </section>
        ) : (
          <div className="message-column">
            {activeConversation.messages.map((message) => (
              <article className={`message message-${message.role}`} key={message.id}>
                <div className="message-avatar" aria-hidden="true">
                  {message.role === "assistant" ? <Sparkles size={16} /> : "You"}
                </div>
                <div className="message-body">
                  <div className="message-label">
                    <span>{message.role === "assistant" ? "Gemini" : "You"}</span>
                    {message.request ? (
                      <span className="message-meta">
                        {message.request.provider === "vertex" ? "Vertex" : "API"} · {message.request.model}
                        {message.request.region ? ` · ${message.request.region}` : ""}
                        {message.tool === "image" ? " · image" : message.tool === "graph" ? " · graph" : ""}
                      </span>
                    ) : message.tool ? (
                      <span className="message-meta">{message.tool === "image" ? "image" : "graph"}</span>
                    ) : null}
                  </div>
                  <div className="message-content" dir={directionFor(message.content)}>
                    {message.role === "assistant"
                      ? message.content
                        ? (
                          <MarkdownMessage
                            complete={message.status !== "streaming"}
                            wrapAsMermaid={message.tool === "graph"}
                          >
                            {message.content}
                          </MarkdownMessage>
                        )
                        : null
                      : <p>{message.content}</p>}
                    {message.status === "streaming" ? <span className="streaming-caret" aria-label="Generating" /> : null}
                  </div>
                  {message.generatedImages?.length ? (
                    <div className="generated-images" aria-label="Generated images">
                      {message.generatedImages.map((image) => (
                        <GeneratedImageCard key={image.id} image={image} />
                      ))}
                    </div>
                  ) : null}
                  {message.attachments?.length ? <MessageAttachments attachments={message.attachments} /> : null}
                  {message.error ? <div className="message-error" role="alert">{message.error}</div> : null}
                  {message.status === "stopped" ? <div className="message-state">Generation stopped</div> : null}
                  {message.role === "assistant" && message.debug ? <MessageDebugBubble debug={message.debug} /> : null}
                  {message.role === "assistant" && message.status !== "streaming" ? (
                    <MessageActions
                      message={message}
                      allowRetry={message.id === lastAssistantId && !running}
                      onRetry={() => retryLast(message)}
                    />
                  ) : null}
                </div>
              </article>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="composer-wrap">
        {configError ? <div className="composer-alert">Server setup unavailable: {configError}</div> : null}
        {attachmentError ? <div className="composer-alert" role="alert">{attachmentError}</div> : null}
        {cacheNotice ? (
          <div className="composer-cache-notice">
            <Database size={14} />
            <span>{cacheNotice}</span>
            <button type="button" className="text-button" onClick={() => setCacheNotice(null)}>Dismiss</button>
          </div>
        ) : null}
        {!configLoading && config && !providerReady ? (
          <div className="composer-alert">
            {config.providers[settings.provider].status}. <Link to="/settings">Review settings</Link>
          </div>
        ) : null}
        <form className="composer" onSubmit={submit}>
          {pendingAttachments.length > 0 || processingFiles ? (
            <div className="pending-attachments" aria-label="Files ready to attach">
              {pendingAttachments.map((attachment) => (
                <div className="pending-attachment" key={attachment.id}>
                  <span className="pending-file-icon"><AttachmentIcon attachment={attachment} /></span>
                  <div><strong>{attachment.name}</strong><small>{attachment.kind.toUpperCase()} · {fileSize(attachment.size)}{attachment.extractedCharacters ? ` · ${attachment.extractedCharacters.toLocaleString()} chars` : ""}</small></div>
                  <button type="button" onClick={() => removePendingAttachment(attachment)} aria-label={`Remove ${attachment.name}`}><X size={14} /></button>
                </div>
              ))}
              {processingFiles ? <div className="attachment-processing"><LoaderCircle size={15} />Reading files…</div> : null}
            </div>
          ) : null}
          <div className="composer-main">
            <input
              ref={fileInputRef}
              className="file-input"
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              onChange={(event) => void addFiles(event.target.files)}
              aria-label="Attach files"
              disabled={running || preparing || processingFiles}
            />
            <button
              type="button"
              className="attach-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={running || preparing || processingFiles}
              aria-label="Choose files"
              title="Attach PDF, Markdown, JSON, text, DOCX, or PPTX"
            >
              {processingFiles ? <LoaderCircle className="spin" size={18} /> : <Paperclip size={18} />}
            </button>
            <ComposerTools
              selected={selectedTool}
              onSelect={setSelectedTool}
              disabled={running || preparing}
            />
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              rows={1}
              placeholder={composerPlaceholder(selectedTool, pendingAttachments.length > 0)}
              aria-label="Message"
              disabled={running || preparing}
            />
            {running ? (
              <button type="button" className="send-button stop-button" onClick={() => abortRef.current?.abort()} aria-label="Stop generating">
                <Square size={15} fill="currentColor" />
              </button>
            ) : (
              <button type="submit" className="send-button" disabled={!canSend} aria-label="Send message">
                {preparing ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={19} />}
              </button>
            )}
          </div>
        </form>
        <p className="composer-footnote">Enter to send · Tools stay on until you switch · Attach up to 10 files / 20 MB</p>
      </div>
    </div>
  );
}
