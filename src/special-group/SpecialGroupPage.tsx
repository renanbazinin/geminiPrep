import { useEffect, useState } from "react";
import { BookOpen, ExternalLink, PlugZap, Users } from "lucide-react";
import type { SpecialGroupConnection, TicketDraft } from "../../shared/special-group/types";
import { useApp } from "../contexts/AppContext";
import { specialGroupApi, type ChatSettings } from "./api";
import { ChatPanel } from "./components/ChatPanel";
import { ConnectPanel } from "./components/ConnectPanel";
import { DraftCard } from "./components/DraftCard";
import { PromptViewer } from "./components/PromptViewer";
import { SessionList } from "./components/SessionList";
import { useProjectOptions, useProjects } from "./jira-data";
import { useSessions } from "./sessions";
import "./special-group.css";

// /special-group: sessions | chat | ticket draft. This file only wires the pieces together.

export function SpecialGroupPage() {
  const { settings } = useApp();
  const sessions = useSessions();
  const session = sessions.active;
  const [connection, setConnection] = useState<SpecialGroupConnection | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [panel, setPanel] = useState<"none" | "connect" | "prompt">("none");
  const [busyId, setBusyId] = useState<string | null>(null);
  const connected = Boolean(connection?.configured);
  const { projects, error: projectsError } = useProjects(connected);
  const projectOptions = useProjectOptions(session.draft.project?.key, connected);

  async function loadConnection() {
    try { const config = await specialGroupApi.config(); setConnection(config); setConnectionError(""); if (!config.configured) setPanel("connect"); }
    catch (reason) { setConnectionError(reason instanceof Error ? reason.message : "Couldn't read the connection."); }
  }
  useEffect(() => { void loadConnection(); }, []);

  // A fresh draft starts in the default project, when one is configured and visible.
  useEffect(() => {
    const key = connection?.defaultProjectKey;
    const project = key ? projects.find(p => p.key === key) : undefined;
    if (project && !session.draft.project && !session.messages.length) {
      sessions.setDraft(session.id, { ...session.draft, project: { id: project.id, key: project.key, name: project.name } });
    }
  }, [connection, projects, session.id]);

  const chatSettings: ChatSettings = {
    provider: settings.provider, model: settings.models[settings.provider],
    ...(settings.provider === "vertex" ? { region: settings.region } : {}),
    temperature: settings.temperature, maxOutputTokens: settings.maxOutputTokens,
    ...(settings.thinkingLevel === "low" || settings.thinkingLevel === "high" ? { thinkingLevel: settings.thinkingLevel } : {}),
  };

  async function send(text: string) {
    const id = session.id;
    const user = { id: crypto.randomUUID(), role: "user" as const, content: text, createdAt: new Date().toISOString() };
    const history = [...session.messages.filter(m => !m.error), user].map(({ role, content }) => ({ role, content }));
    sessions.addMessage(id, user);
    setBusyId(id);
    try {
      const result = await specialGroupApi.chat({ ...chatSettings, messages: history, draft: session.draft });
      if (result.draft) sessions.setDraft(id, result.draft);
      sessions.addMessage(id, { id: crypto.randomUUID(), role: "assistant", content: result.text, createdAt: new Date().toISOString(),
        ...(result.link ? { link: result.link } : {}), lookups: result.lookups });
    } catch (reason) {
      sessions.addMessage(id, { id: crypto.randomUUID(), role: "assistant", error: true, createdAt: new Date().toISOString(),
        content: reason instanceof Error ? reason.message : "The request failed." });
    } finally { setBusyId(null); }
  }

  const siteUrl = connection?.siteUrl ?? "";
  return <div className="sg-page">
    <header className="sg-header">
      <div>
        <div className="sg-eyebrow"><Users size={15} /> SPECIAL GROUP · READ-ONLY JIRA</div>
        <h1>Special Group <span>ticket assistant</span></h1>
        <p>Describe the work. The assistant checks Jira and prepares a ticket you open in Jira with everything filled in.</p>
      </div>
      <div className="sg-header-actions">
        <button className="secondary-button" aria-pressed={panel === "prompt"} onClick={() => setPanel(panel === "prompt" ? "none" : "prompt")}><BookOpen size={15} /> Instructions</button>
        <button className="secondary-button" aria-pressed={panel === "connect"} onClick={() => setPanel(panel === "connect" ? "none" : "connect")}><PlugZap size={15} /> {connected ? "Connected" : "Connect"}</button>
        {siteUrl && <a className="secondary-button" href={siteUrl} target="_blank" rel="noreferrer">Open Jira <ExternalLink size={13} /></a>}
      </div>
    </header>
    {(connectionError || projectsError) && <p className="sg-error" role="alert">{connectionError || projectsError}</p>}
    {panel === "connect" && connection && <ConnectPanel siteUrl={connection.siteUrl} onConnected={() => { void loadConnection(); setPanel("none"); }} />}
    {panel === "prompt" && <PromptViewer />}
    <div className="sg-workspace">
      <SessionList sessions={sessions.sessions} activeId={session.id} busyId={busyId}
        onSelect={sessions.select} onCreate={sessions.create} onDelete={sessions.remove} />
      <ChatPanel messages={session.messages} busy={busyId === session.id} canSend={connected && busyId === null}
        modelLabel={chatSettings.model} onSend={text => void send(text)} />
      <DraftCard draft={session.draft} siteUrl={siteUrl} projects={projects}
        options={projectOptions.options} optionsLoading={projectOptions.loading} optionsError={projectOptions.error}
        disabled={busyId === session.id} onReloadOptions={projectOptions.reload}
        onChange={(draft: TicketDraft) => sessions.setDraft(session.id, draft)} />
    </div>
  </div>;
}
