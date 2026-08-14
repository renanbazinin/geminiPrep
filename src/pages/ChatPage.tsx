import {
  ArrowUp,
  Check,
  Copy,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import type { ChatMessage, ChatStreamRequest } from "../../shared/contracts";
import { MarkdownMessage } from "../components/MarkdownMessage";
import { useApp } from "../contexts/AppContext";
import { useConfig } from "../contexts/ConfigContext";
import { streamChat } from "../lib/api";
import { createId } from "../lib/storage";

const SUGGESTIONS = [
  "Explain how Vertex AI regional endpoints differ from the global endpoint.",
  "Help me design a safe model rollout checklist for an enterprise chatbot.",
  "Compare Gemini Flash and Pro for a customer-support assistant.",
];

function directionFor(text: string): "rtl" | "ltr" {
  return /[\u0590-\u08ff]/.test(text) ? "rtl" : "ltr";
}

function messageHistory(messages: ChatMessage[]): ChatStreamRequest["messages"] {
  return messages
    .filter((message) => message.content.trim() && message.status !== "error")
    .map((message) => ({ role: message.role, content: message.content }));
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
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [activeConversation.messages]);

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
  const canSend = draft.trim().length > 0 && !running && !configLoading && Boolean(config);

  async function run(
    conversationId: string,
    history: ChatStreamRequest["messages"],
    assistantId: string,
  ) {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    let assembled = "";
    try {
      await streamChat({
        provider: settings.provider,
        model: activeModel,
        ...(settings.provider === "vertex" ? { region: settings.region } : {}),
        systemInstruction: settings.systemInstruction,
        temperature: settings.temperature,
        maxOutputTokens: settings.maxOutputTokens,
        messages: history,
      }, {
        onDelta(text) {
          assembled += text;
          updateMessage(conversationId, assistantId, { content: assembled });
        },
        onDone() {
          updateMessage(conversationId, assistantId, { status: "complete", content: assembled });
        },
      }, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        updateMessage(conversationId, assistantId, { status: "stopped", content: assembled });
      } else {
        updateMessage(conversationId, assistantId, {
          status: "error",
          content: assembled,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  }

  function startWithText(text: string) {
    const clean = text.trim();
    if (!clean || running || !config) return;
    const conversationId = activeConversation.id;
    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: clean,
      createdAt: now,
      status: "complete",
    };
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: "assistant",
      content: "",
      createdAt: now,
      status: "streaming",
      request: {
        provider: settings.provider,
        model: activeModel,
        ...(settings.provider === "vertex" ? { region: settings.region } : {}),
      },
    };
    appendMessages(conversationId, [userMessage, assistantMessage]);
    setDraft("");
    void run(
      conversationId,
      [...messageHistory(activeConversation.messages), { role: "user", content: clean }],
      assistantMessage.id,
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSend) startWithText(draft);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) startWithText(draft);
    }
  }

  function retryLast(message: ChatMessage) {
    if (running || !config) return;
    const index = activeConversation.messages.findIndex((candidate) => candidate.id === message.id);
    if (index < 1) return;
    const baseMessages = activeConversation.messages.slice(0, index);
    if (baseMessages.at(-1)?.role !== "user") return;
    removeMessage(activeConversation.id, message.id);
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "streaming",
      request: {
        provider: settings.provider,
        model: activeModel,
        ...(settings.provider === "vertex" ? { region: settings.region } : {}),
      },
    };
    appendMessages(activeConversation.id, [assistantMessage]);
    void run(activeConversation.id, messageHistory(baseMessages), assistantMessage.id);
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
                <button key={suggestion} onClick={() => startWithText(suggestion)} disabled={!config || running}>
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
                      </span>
                    ) : null}
                  </div>
                  <div className="message-content" dir={directionFor(message.content)}>
                    {message.role === "assistant"
                      ? message.content ? <MarkdownMessage>{message.content}</MarkdownMessage> : null
                      : <p>{message.content}</p>}
                    {message.status === "streaming" ? <span className="streaming-caret" aria-label="Generating" /> : null}
                  </div>
                  {message.error ? <div className="message-error" role="alert">{message.error}</div> : null}
                  {message.status === "stopped" ? <div className="message-state">Generation stopped</div> : null}
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
        {!configLoading && config && !providerReady ? (
          <div className="composer-alert">
            {config.providers[settings.provider].status}. <Link to="/settings">Review settings</Link>
          </div>
        ) : null}
        <form className="composer" onSubmit={submit}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            rows={1}
            placeholder="Message Gemini Prep…"
            aria-label="Message"
            disabled={running}
          />
          {running ? (
            <button type="button" className="send-button stop-button" onClick={() => abortRef.current?.abort()} aria-label="Stop generating">
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" className="send-button" disabled={!canSend} aria-label="Send message">
              <ArrowUp size={19} />
            </button>
          )}
        </form>
        <p className="composer-footnote">Enter to send · Shift + Enter for a new line · Conversations are stored locally</p>
      </div>
    </div>
  );
}
