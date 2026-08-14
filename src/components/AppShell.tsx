import {
  FlaskConical,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeftClose,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../contexts/AppContext";

function formatRelativeDate(iso: string): string {
  const timestamp = new Date(iso).getTime();
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function AppShell() {
  const {
    conversations,
    activeConversationId,
    setActiveConversationId,
    newConversation,
    renameConversation,
    deleteConversation,
    clearConversations,
  } = useApp();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [manageDialog, setManageDialog] = useState<
    | { type: "rename"; id: string; title: string }
    | { type: "delete"; id: string; title: string }
    | { type: "clear" }
    | null
  >(null);
  const [renameDraft, setRenameDraft] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const sortedConversations = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  function openConversation(id: string) {
    setActiveConversationId(id);
    navigate("/");
    setDrawerOpen(false);
  }

  function createNew() {
    newConversation();
    navigate("/");
    setDrawerOpen(false);
  }

  function rename(id: string, currentTitle: string) {
    setRenameDraft(currentTitle);
    setManageDialog({ type: "rename", id, title: currentTitle });
  }

  function remove(id: string, title: string) {
    setManageDialog({ type: "delete", id, title });
  }

  function confirmManageAction() {
    if (!manageDialog) return;
    if (manageDialog.type === "rename") renameConversation(manageDialog.id, renameDraft);
    if (manageDialog.type === "delete") deleteConversation(manageDialog.id);
    if (manageDialog.type === "clear") clearConversations();
    setManageDialog(null);
  }

  const pageTitle = location.pathname === "/settings"
    ? "Settings"
    : location.pathname === "/tests/cache"
      ? "Cache test"
      : location.pathname === "/tests/regions" ? "Regions test" : location.pathname === "/tests" ? "Tests" : "Chat";

  return (
    <div className="app-shell">
      <button
        className={`drawer-scrim${drawerOpen ? " drawer-scrim-open" : ""}`}
        aria-label="Close navigation"
        onClick={() => setDrawerOpen(false)}
      />
      <aside className={`sidebar${drawerOpen ? " sidebar-open" : ""}`} aria-label="Main navigation">
        <div className="brand-row">
          <NavLink to="/" className="brand" onClick={() => setDrawerOpen(false)}>
            <span className="brand-mark"><Sparkles size={17} /></span>
            <span>Gemini Prep</span>
          </NavLink>
          <button className="icon-button sidebar-close" onClick={() => setDrawerOpen(false)} aria-label="Close sidebar">
            <PanelLeftClose size={18} />
          </button>
        </div>

        <button className="new-chat-button" onClick={createNew}>
          <MessageSquarePlus size={18} />
          <span>New conversation</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="sidebar-section-label">Conversations</div>
        <div className="conversation-list">
          {sortedConversations.map((conversation) => (
            <div
              className={`conversation-row${
                location.pathname === "/" && conversation.id === activeConversationId ? " conversation-row-active" : ""
              }`}
              key={conversation.id}
            >
              <button className="conversation-main" onClick={() => openConversation(conversation.id)}>
                <span className="conversation-title">{conversation.title}</span>
                <span className="conversation-date">{formatRelativeDate(conversation.updatedAt)}</span>
              </button>
              <div className="conversation-actions">
                <button
                  className="conversation-action"
                  onClick={() => rename(conversation.id, conversation.title)}
                  aria-label={`Rename ${conversation.title}`}
                  title="Rename"
                >
                  <MoreHorizontal size={15} />
                </button>
                <button
                  className="conversation-action"
                  onClick={() => remove(conversation.id, conversation.title)}
                  aria-label={`Delete ${conversation.title}`}
                  title="Delete"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/tests" className={({ isActive }) => `sidebar-link${isActive ? " sidebar-link-active" : ""}`} onClick={() => setDrawerOpen(false)}>
            <FlaskConical size={18} />
            <span>Tests</span>
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `sidebar-link${isActive ? " sidebar-link-active" : ""}`} onClick={() => setDrawerOpen(false)}>
            <Settings size={18} />
            <span>Settings</span>
          </NavLink>
          <button
            className="sidebar-link danger-link"
            onClick={() => setManageDialog({ type: "clear" })}
          >
            <Trash2 size={18} />
            <span>Clear conversations</span>
          </button>
        </nav>
      </aside>

      <main className="main-area">
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
            <Menu size={20} />
          </button>
          <span>{pageTitle}</span>
          <span className="mobile-header-spacer" />
        </header>
        <Outlet />
      </main>

      {manageDialog ? (
        <div className="cell-dialog-backdrop" role="presentation" onMouseDown={() => setManageDialog(null)}>
          <form
            className="manage-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manage-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              confirmManageAction();
            }}
          >
            <h2 id="manage-dialog-title">
              {manageDialog.type === "rename"
                ? "Rename conversation"
                : manageDialog.type === "delete" ? "Delete conversation?" : "Clear all conversations?"}
            </h2>
            {manageDialog.type === "rename" ? (
              <label className="form-field">
                <span>Conversation title</span>
                <input
                  autoFocus
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  maxLength={80}
                />
              </label>
            ) : (
              <p>
                {manageDialog.type === "delete"
                  ? `“${manageDialog.title}” will be removed from this browser.`
                  : "Every locally stored conversation will be removed from this browser."}
                {" "}This cannot be undone.
              </p>
            )}
            <div className="manage-dialog-actions">
              <button type="button" className="secondary-button" onClick={() => setManageDialog(null)}>Cancel</button>
              <button
                type="submit"
                className={manageDialog.type === "rename" ? "primary-button" : "danger-button"}
                disabled={manageDialog.type === "rename" && !renameDraft.trim()}
              >
                {manageDialog.type === "rename" ? "Save" : manageDialog.type === "delete" ? "Delete" : "Clear all"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
