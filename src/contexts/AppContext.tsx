import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AppSettings, ChatMessage, Conversation, PublicConfig } from "../../shared/contracts";
import {
  FALLBACK_SETTINGS,
  conversationTitle,
  createConversation,
  loadConversations,
  loadActiveConversationId,
  saveActiveConversationId,
  loadSettings,
  saveConversations,
  saveSettings,
  settingsForConfig,
} from "../lib/storage";
import { deleteAttachmentPayloads } from "../lib/attachments";
import { deleteGeneratedImages } from "../lib/generated-images";

type AppContextValue = {
  storageError: string | null;
  conversations: Conversation[];
  activeConversationId: string;
  activeConversation: Conversation;
  settings: AppSettings;
  setActiveConversationId(id: string): void;
  newConversation(): string;
  renameConversation(id: string, title: string): void;
  deleteConversation(id: string): void;
  clearConversations(): void;
  appendMessages(conversationId: string, messages: ChatMessage[]): void;
  updateMessage(conversationId: string, messageId: string, patch: Partial<ChatMessage>): void;
  removeMessage(conversationId: string, messageId: string): void;
  clearInteractionReferences(conversationId: string): void;
  updateSettings(patch: Partial<AppSettings>): void;
  resetSettings(config?: PublicConfig): void;
  reconcileSettings(config: PublicConfig): void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeConversationId, setActiveConversationIdState] = useState(() => loadActiveConversationId(conversations));
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  const [conversationStorageError, setConversationStorageError] = useState<string | null>(null);
  const [settingsStorageError, setSettingsStorageError] = useState<string | null>(null);
  useEffect(() => {
    try { saveConversations(conversations); setConversationStorageError(null); }
    catch { setConversationStorageError("Browser storage is full or unavailable. This chat is still open, but new messages may not survive a reload. Export important content before closing."); }
  }, [conversations]);
  useEffect(() => {
    try { saveSettings(settings); setSettingsStorageError(null); }
    catch { setSettingsStorageError("Settings could not be saved in this browser. Changes apply now but may not survive a reload."); }
  }, [settings]);
  useEffect(() => {
    try { saveActiveConversationId(activeConversationId); }
    catch { /* The conversation/settings warnings already explain unavailable storage. */ }
  }, [activeConversationId]);

  const mutateConversation = useCallback(
    (id: string, updater: (conversation: Conversation) => Conversation) => {
      setConversations((current) => current.map((conversation) => (
        conversation.id === id ? updater(conversation) : conversation
      )));
    },
    [],
  );

  const newConversation = useCallback(() => {
    const conversation = createConversation();
    setConversations((current) => [conversation, ...current]);
    setActiveConversationIdState(conversation.id);
    return conversation.id;
  }, []);

  const renameConversation = useCallback((id: string, title: string) => {
    const clean = title.replace(/\s+/g, " ").trim();
    if (!clean) return;
    mutateConversation(id, (conversation) => ({ ...conversation, title: clean.slice(0, 80) }));
  }, [mutateConversation]);

  const deleteConversation = useCallback((id: string) => {
    const conversation = conversations.find((entry) => entry.id === id);
    const attachments = conversation?.messages.flatMap((message) => message.attachments ?? []) ?? [];
    const images = conversation?.messages.flatMap((message) => message.generatedImages ?? []) ?? [];
    void deleteAttachmentPayloads(attachments).catch(() => undefined);
    void deleteGeneratedImages(images).catch(() => undefined);
    setConversations((current) => {
      const remaining = current.filter((conversation) => conversation.id !== id);
      if (remaining.length > 0) {
        if (activeConversationId === id) setActiveConversationIdState(remaining[0]!.id);
        return remaining;
      }
      const replacement = createConversation();
      setActiveConversationIdState(replacement.id);
      return [replacement];
    });
  }, [activeConversationId, conversations]);

  const clearConversations = useCallback(() => {
    const attachments = conversations.flatMap((conversation) => (
      conversation.messages.flatMap((message) => message.attachments ?? [])
    ));
    const images = conversations.flatMap((conversation) => (
      conversation.messages.flatMap((message) => message.generatedImages ?? [])
    ));
    void deleteAttachmentPayloads(attachments).catch(() => undefined);
    void deleteGeneratedImages(images).catch(() => undefined);
    const replacement = createConversation();
    setConversations([replacement]);
    setActiveConversationIdState(replacement.id);
  }, [conversations]);

  const appendMessages = useCallback((conversationId: string, messages: ChatMessage[]) => {
    mutateConversation(conversationId, (conversation) => {
      const firstUser = conversation.messages.length === 0
        ? messages.find((message) => message.role === "user")
        : undefined;
      return {
        ...conversation,
        title: firstUser ? conversationTitle(firstUser.content) : conversation.title,
        updatedAt: new Date().toISOString(),
        messages: [...conversation.messages, ...messages],
      };
    });
  }, [mutateConversation]);

  const updateMessage = useCallback((conversationId: string, messageId: string, patch: Partial<ChatMessage>) => {
    mutateConversation(conversationId, (conversation) => ({
      ...conversation,
      updatedAt: new Date().toISOString(),
      messages: conversation.messages.map((message) => (
        message.id === messageId ? { ...message, ...patch } : message
      )),
    }));
  }, [mutateConversation]);

  const removeMessage = useCallback((conversationId: string, messageId: string) => {
    mutateConversation(conversationId, (conversation) => ({
      ...conversation,
      updatedAt: new Date().toISOString(),
      messages: conversation.messages.filter((message) => message.id !== messageId),
    }));
  }, [mutateConversation]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
  }, []);

  const clearInteractionReferences = useCallback((conversationId: string) => {
    mutateConversation(conversationId, (conversation) => ({ ...conversation,
      messages: conversation.messages.map((message) => ({ ...message, interaction: undefined })),
    }));
  }, [mutateConversation]);

  const resetSettings = useCallback((config?: PublicConfig) => {
    setSettings(config ? settingsForConfig(FALLBACK_SETTINGS, config) : FALLBACK_SETTINGS);
  }, []);

  const reconcileSettings = useCallback((config: PublicConfig) => {
    setSettings((current) => settingsForConfig(current, config));
  }, []);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)
    ?? conversations[0]!;
  const value = useMemo<AppContextValue>(() => ({
    storageError: conversationStorageError ?? settingsStorageError,
    conversations,
    activeConversationId: activeConversation.id,
    activeConversation,
    settings,
    setActiveConversationId: setActiveConversationIdState,
    newConversation,
    renameConversation,
    deleteConversation,
    clearConversations,
    appendMessages,
    updateMessage,
    removeMessage,
    clearInteractionReferences,
    updateSettings,
    resetSettings,
    reconcileSettings,
  }), [
    conversationStorageError,
    settingsStorageError,
    activeConversation,
    appendMessages,
    clearConversations,
    clearInteractionReferences,
    conversations,
    deleteConversation,
    newConversation,
    reconcileSettings,
    removeMessage,
    renameConversation,
    resetSettings,
    settings,
    updateMessage,
    updateSettings,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}
