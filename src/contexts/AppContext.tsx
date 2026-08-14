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
  loadSettings,
  saveConversations,
  saveSettings,
  settingsForConfig,
} from "../lib/storage";

type AppContextValue = {
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
  updateSettings(patch: Partial<AppSettings>): void;
  resetSettings(config?: PublicConfig): void;
  reconcileSettings(config: PublicConfig): void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>(loadConversations);
  const [activeConversationId, setActiveConversationIdState] = useState(() => conversations[0]!.id);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  useEffect(() => saveConversations(conversations), [conversations]);
  useEffect(() => saveSettings(settings), [settings]);

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
  }, [activeConversationId]);

  const clearConversations = useCallback(() => {
    const replacement = createConversation();
    setConversations([replacement]);
    setActiveConversationIdState(replacement.id);
  }, []);

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

  const resetSettings = useCallback((config?: PublicConfig) => {
    setSettings(config ? settingsForConfig(FALLBACK_SETTINGS, config) : FALLBACK_SETTINGS);
  }, []);

  const reconcileSettings = useCallback((config: PublicConfig) => {
    setSettings((current) => settingsForConfig(current, config));
  }, []);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId)
    ?? conversations[0]!;
  const value = useMemo<AppContextValue>(() => ({
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
    updateSettings,
    resetSettings,
    reconcileSettings,
  }), [
    activeConversation,
    appendMessages,
    clearConversations,
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

