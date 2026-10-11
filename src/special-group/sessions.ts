import { useCallback, useEffect, useState } from "react";
import { sanitizeDraft } from "../../shared/special-group/draft";
import type { SpecialGroupMessage, SpecialGroupSession, TicketDraft } from "../../shared/special-group/types";

// Chat sessions for this page only, kept in this browser's localStorage (separate from the main chat).
// Each session holds its messages and its own ticket draft.

const STORAGE_KEY = "gemini-prep-special-group-sessions-v1";
const ACTIVE_KEY = "gemini-prep-special-group-active-v1";
const MAX_SESSIONS = 50;

export function newSession(): SpecialGroupSession {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), title: "New ticket", createdAt: now, updatedAt: now, messages: [], draft: {} };
}

export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 48 ? `${line.slice(0, 47)}…` : line || "New ticket";
}

function isMessage(value: any): value is SpecialGroupMessage {
  return value && typeof value.id === "string" && typeof value.content === "string" && ["user", "assistant"].includes(value.role);
}

export function loadSessions(): SpecialGroupSession[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter(s => s && typeof s.id === "string").slice(0, MAX_SESSIONS).map(s => ({
      id: s.id, title: String(s.title ?? "New ticket"), createdAt: String(s.createdAt ?? ""), updatedAt: String(s.updatedAt ?? ""),
      messages: Array.isArray(s.messages) ? s.messages.filter(isMessage) : [], draft: sanitizeDraft(s.draft),
    }));
  } catch { return []; }
}

function persist(sessions: SpecialGroupSession[], activeId: string) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
    localStorage.setItem(ACTIVE_KEY, activeId);
  } catch { /* Storage can be full or blocked; the page still works for this visit. */ }
}

export function useSessions() {
  const [state, setState] = useState(() => {
    const sessions = loadSessions();
    const list = sessions.length ? sessions : [newSession()];
    let activeId: string | null = null;
    try { activeId = localStorage.getItem(ACTIVE_KEY); } catch { /* ignore */ }
    return { sessions: list, activeId: list.some(s => s.id === activeId) ? activeId! : list[0]!.id };
  });
  useEffect(() => persist(state.sessions, state.activeId), [state]);

  const update = useCallback((id: string, change: (session: SpecialGroupSession) => SpecialGroupSession) => {
    setState(current => ({ ...current, sessions: current.sessions.map(s => s.id === id ? { ...change(s), updatedAt: new Date().toISOString() } : s) }));
  }, []);

  return {
    sessions: [...state.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    active: state.sessions.find(s => s.id === state.activeId) ?? state.sessions[0]!,
    select: (id: string) => setState(current => ({ ...current, activeId: id })),
    create: () => {
      const session = newSession();
      setState(current => ({ sessions: [session, ...current.sessions], activeId: session.id }));
    },
    remove: (id: string) => setState(current => {
      const rest = current.sessions.filter(s => s.id !== id);
      const sessions = rest.length ? rest : [newSession()];
      return { sessions, activeId: current.activeId === id ? sessions[0]!.id : current.activeId };
    }),
    addMessage: (id: string, message: SpecialGroupMessage) => update(id, s => ({
      ...s, messages: [...s.messages, message],
      title: s.messages.length === 0 && message.role === "user" ? titleFrom(message.content) : s.title,
    })),
    setDraft: (id: string, draft: TicketDraft) => update(id, s => ({ ...s, draft })),
  };
}
