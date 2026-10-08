// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppProvider, useApp } from "./AppContext";
import { createConversation, saveActiveConversationId, saveConversations } from "../lib/storage";

function Probe() {
  const app = useApp();
  return <><p>{app.activeConversation.title}</p><p role="alert">{app.storageError}</p>
    <button onClick={() => app.renameConversation(app.activeConversationId, "Still editable")}>Rename</button>
    <button onClick={() => app.clearInteractionReferences(app.activeConversationId)}>Reconnect</button>
    <output>{JSON.stringify(app.conversations)}</output></>;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

it("restores the selected conversation and invalidates only its references", () => {
  const first = { ...createConversation(), title: "First", messages: [{ id: "a", role: "assistant" as const, content: "Hello", status: "complete" as const, createdAt: "2026-01-01", interaction: { id: "old", model: "model", apiVersion: "v1" as const } }] };
  const second = { ...first, id: "second", title: "Selected" };
  saveConversations([first, second]);
  saveActiveConversationId(second.id);
  render(<AppProvider><Probe /></AppProvider>);
  expect(screen.getByText("Selected")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
  const stored = JSON.parse(localStorage.getItem("gemini-prep:conversations:v1")!);
  expect(stored[0].messages[0].interaction.id).toBe("old");
  expect(stored[1].messages[0]).not.toHaveProperty("interaction");
  expect(stored[1].messages[0].content).toBe("Hello");
});

it("falls back to an existing chat when the selected chat no longer exists", () => {
  saveConversations([{ ...createConversation(), title: "Available" }]);
  saveActiveConversationId("deleted");
  render(<AppProvider><Probe /></AppProvider>);
  expect(screen.getByText("Available")).toBeInTheDocument();
});

it("keeps the chat usable and warns when browser persistence fails", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
  render(<AppProvider><Probe /></AppProvider>);
  expect(screen.getByRole("alert")).toHaveTextContent("Browser storage is full or unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect(screen.getByText("Still editable")).toBeInTheDocument();
});
