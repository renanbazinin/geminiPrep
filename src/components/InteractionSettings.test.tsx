// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppProvider, useApp } from "../contexts/AppContext";
import { InteractionSettings } from "./InteractionSettings";
import { FALLBACK_SETTINGS } from "../lib/storage";

function Harness() {
  const { settings, resetSettings } = useApp();
  return <><InteractionSettings /><button onClick={() => resetSettings()}>Reset</button><output data-testid="settings">{JSON.stringify(settings.interactions)}</output></>;
}
afterEach(() => { cleanup(); localStorage.clear(); });
it("keeps storage and stateful memory consistent and persists the choice", () => {
  render(<AppProvider><Harness /></AppProvider>);
  fireEvent.click(screen.getByRole("checkbox", { name: /Store interactions with Google/ }));
  expect(screen.getByRole("combobox", { name: /Conversation memory/ })).toHaveValue("history");
  expect(JSON.parse(localStorage.getItem("gemini-prep:settings:v1")!).interactions).toMatchObject({ stateful: false, store: false });
  fireEvent.change(screen.getByRole("combobox", { name: /Conversation memory/ }), { target: { value: "stateful" } });
  expect(screen.getByRole("checkbox", { name: /Store interactions with Google/ })).toBeChecked();
});
it("edits multiline stop sequences without losing focus or the pending newline, and resets", () => {
  render(<AppProvider><Harness /></AppProvider>);
  const textarea = screen.getByRole("textbox", { name: /Stop sequences/ });
  textarea.focus();
  fireEvent.change(textarea, { target: { value: "END\n" } });
  expect(textarea).toHaveFocus();
  expect(textarea).toHaveValue("END\n");
  fireEvent.change(textarea, { target: { value: "END\nSTOP" } });
  expect(screen.getByTestId("settings").textContent).toContain('"stopSequences":["END","STOP"]');
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(textarea).toHaveValue("");
});
it("gates beta-only controls and validates response schemas", () => {
  render(<AppProvider><Harness /></AppProvider>);
  expect(screen.getByRole("spinbutton", { name: /Top P/ })).toBeDisabled();
  fireEvent.change(screen.getByRole("combobox", { name: /API version/ }), { target: { value: "v1beta" } });
  expect(screen.getByRole("spinbutton", { name: /Top P/ })).toBeEnabled();
  fireEvent.change(screen.getByRole("combobox", { name: /Response format/ }), { target: { value: "json" } });
  fireEvent.change(screen.getByRole("textbox", { name: /JSON response schema/ }), { target: { value: "{" } });
  expect(screen.getByRole("alert")).toHaveTextContent("Response schema must be valid JSON");
});
it("exposes Cloud memory and sampling with a fixed preview version and independent API choices", () => {
  localStorage.setItem("gemini-prep:settings:v1", JSON.stringify({ ...FALLBACK_SETTINGS, provider: "vertex", vertexApi: "interactions" }));
  render(<AppProvider><Harness /></AppProvider>);
  expect(screen.getByText("v1beta1 · Google Cloud Preview")).toBeInTheDocument();
  expect(screen.getByRole("spinbutton", { name: /Top P/ })).toBeEnabled();
  expect(screen.queryByRole("combobox", { name: /API version/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Vertex API mode" }), { target: { value: "generateContent" } });
  const stored = JSON.parse(localStorage.getItem("gemini-prep:settings:v1")!);
  expect(stored).toMatchObject({ vertexApi: "generateContent", geminiApi: "interactions" });
  expect(screen.queryByRole("combobox", { name: /Conversation memory/ })).not.toBeInTheDocument();
});
