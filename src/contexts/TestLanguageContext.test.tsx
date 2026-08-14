// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestLanguageProvider, useTestLanguage } from "./TestLanguageContext";

const STORAGE_KEY = "gemini-prep:test-language:v1";

function Probe() {
  const { language, direction, toggleLanguage } = useTestLanguage();
  return <button onClick={toggleLanguage}>{language}:{direction}</button>;
}

describe("test-area language preference", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("defaults to English and persists a Hebrew RTL choice", async () => {
    render(<TestLanguageProvider><Probe /></TestLanguageProvider>);
    expect(screen.getByRole("button")).toHaveTextContent("en:ltr");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("he:rtl");
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe("he"));
  });

  it("recovers unsupported stored values as English", () => {
    localStorage.setItem(STORAGE_KEY, "fr");
    render(<TestLanguageProvider><Probe /></TestLanguageProvider>);
    expect(screen.getByRole("button")).toHaveTextContent("en:ltr");
  });

  it("restores Hebrew on the next mount", () => {
    localStorage.setItem(STORAGE_KEY, "he");
    render(<TestLanguageProvider><Probe /></TestLanguageProvider>);
    expect(screen.getByRole("button")).toHaveTextContent("he:rtl");
  });
});
