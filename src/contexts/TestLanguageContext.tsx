import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { TestLanguage } from "../../shared/contracts";

const STORAGE_KEY = "gemini-prep:test-language:v1";

type TestLanguageContextValue = {
  language: TestLanguage;
  direction: "ltr" | "rtl";
  setLanguage(language: TestLanguage): void;
  toggleLanguage(): void;
};

const TestLanguageContext = createContext<TestLanguageContextValue | null>(null);

function initialLanguage(): TestLanguage {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "he" ? "he" : "en";
}

export function TestLanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<TestLanguage>(initialLanguage);
  useEffect(() => localStorage.setItem(STORAGE_KEY, language), [language]);
  const value = useMemo<TestLanguageContextValue>(() => ({
    language,
    direction: language === "he" ? "rtl" : "ltr",
    setLanguage,
    toggleLanguage: () => setLanguage((current) => current === "en" ? "he" : "en"),
  }), [language]);
  return <TestLanguageContext.Provider value={value}>{children}</TestLanguageContext.Provider>;
}

export function useTestLanguage(): TestLanguageContextValue {
  const value = useContext(TestLanguageContext);
  if (!value) throw new Error("useTestLanguage must be used inside TestLanguageProvider");
  return value;
}

