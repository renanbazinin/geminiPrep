import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PublicConfig } from "../../shared/contracts";
import { fetchConfig } from "../lib/api";
import { useApp } from "./AppContext";

type ConfigContextValue = {
  config: PublicConfig | null;
  loading: boolean;
  error: string | null;
  reload(): void;
};

const ConfigContext = createContext<ConfigContextValue | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const { reconcileSettings } = useApp();
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchConfig(controller.signal)
      .then((value) => {
        setConfig(value);
        reconcileSettings(value);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reconcileSettings, reloadToken]);

  return (
    <ConfigContext.Provider
      value={{ config, loading, error, reload: () => setReloadToken((value) => value + 1) }}
    >
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig(): ConfigContextValue {
  const value = useContext(ConfigContext);
  if (!value) throw new Error("useConfig must be used inside ConfigProvider");
  return value;
}

