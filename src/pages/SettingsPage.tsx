import { AlertTriangle, CheckCircle2, Cloud, Database, KeyRound, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProviderId, StoredCacheEntry, ThinkingLevel } from "../../shared/contracts";
import { useApp } from "../contexts/AppContext";
import { useConfig } from "../contexts/ConfigContext";
import { forgetCache, formatRemaining, loadCaches, remainingMs } from "../lib/cache-registry";

export function SettingsPage() {
  const { settings, updateSettings, resetSettings } = useApp();
  const { config, loading, error, reload } = useConfig();

  function selectProvider(provider: ProviderId) {
    updateSettings({ provider });
  }

  return (
    <div className="route-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">RUNTIME PREFERENCES</p>
          <h1>Settings</h1>
          <p>Choose how the next response is generated. Credentials remain on the local server.</p>
        </div>
        <button className="secondary-button" onClick={() => resetSettings(config ?? undefined)}>
          <RotateCcw size={16} /> Reset defaults
        </button>
      </header>

      {error ? (
        <div className="panel-error" role="alert">
          <span>{error}</span>
          <button onClick={reload}>Try again</button>
        </div>
      ) : null}

      <section className="settings-section">
        <div className="settings-section-title">
          <Cloud size={19} />
          <div><h2>Provider</h2><p>Vertex is the primary enterprise path; Gemini API is available for comparison.</p></div>
        </div>
        <div className="provider-cards" aria-label="Provider" role="radiogroup">
          {(["vertex", "gemini"] as const).map((provider) => {
            const providerConfig = config?.providers[provider];
            return (
              <button
                key={provider}
                className={`provider-card${settings.provider === provider ? " provider-card-selected" : ""}`}
                onClick={() => selectProvider(provider)}
                role="radio"
                aria-checked={settings.provider === provider}
              >
                <span className={`provider-card-icon provider-card-icon-${provider}`}>
                  {provider === "vertex" ? <Cloud size={20} /> : <KeyRound size={20} />}
                </span>
                <span className="provider-card-copy">
                  <strong>{provider === "vertex" ? "Vertex AI" : "Gemini Developer API"}</strong>
                  <small>{providerConfig?.status ?? (loading ? "Checking local server…" : "Not available")}</small>
                </span>
                {providerConfig?.ready ? <CheckCircle2 className="ready-icon" size={19} /> : <span className="setup-pill">Setup</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <SlidersHorizontal size={19} />
          <div><h2>Model configuration</h2><p>These controls are captured with every assistant response.</p></div>
        </div>
        <div className="settings-grid">
          <label className="form-field">
            <span>Model</span>
            <select
              value={settings.models[settings.provider]}
              onChange={(event) => updateSettings({
                models: { ...settings.models, [settings.provider]: event.target.value },
              })}
              disabled={!config}
            >
              {(config?.providers[settings.provider].models ?? []).map((model) => (
                <option key={model.id} value={model.id}>{model.label} · {model.id}</option>
              ))}
            </select>
          </label>

          {settings.provider === "vertex" ? (
            <label className="form-field">
              <span>Region</span>
              <select value={settings.region} onChange={(event) => updateSettings({ region: event.target.value })} disabled={!config}>
                {(config?.regions ?? []).map((region) => (
                  <option key={region.id} value={region.id}>{region.label} · {region.id}</option>
                ))}
              </select>
              <small>The region changes the Vertex hostname and resource location.</small>
            </label>
          ) : (
            <div className="form-field form-field-static">
              <span>Endpoint</span>
              <strong>Global Gemini API</strong>
              <small>The Developer API does not expose a Vertex-style region selector.</small>
            </div>
          )}

          <label className="form-field form-field-wide">
            <span>System instruction</span>
            <textarea
              rows={5}
              value={settings.systemInstruction}
              onChange={(event) => updateSettings({ systemInstruction: event.target.value })}
              placeholder="Optional behavior, role, tone, and constraints for the assistant…"
              maxLength={20_000}
            />
            <small>{settings.systemInstruction.length.toLocaleString()} / 20,000 characters</small>
          </label>

          <label className="form-field">
            <span className="range-label">Temperature <strong>{settings.temperature.toFixed(2)}</strong></span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={settings.temperature}
              onChange={(event) => updateSettings({ temperature: Number(event.target.value) })}
            />
            <small>Lower is more consistent; higher is more varied.</small>
          </label>

          <label className="form-field">
            <span>Maximum output tokens</span>
            <input
              type="number"
              min={1}
              max={65_536}
              step={256}
              value={settings.maxOutputTokens}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) updateSettings({ maxOutputTokens: Math.min(65_536, Math.max(1, Math.round(value))) });
              }}
            />
            <small>Provider/model limits may be lower than this local guardrail.</small>
          </label>

          <label className="form-field">
            <span>Thinking level</span>
            <select
              value={settings.thinkingLevel}
              onChange={(event) => updateSettings({ thinkingLevel: event.target.value as ThinkingLevel })}
            >
              <option value="high">high — deeper reasoning (API default)</option>
              <option value="low">low — faster, leaves more room for the answer</option>
            </select>
            <small>
              Gemini 3 bills thinking tokens against maximum output tokens and reports them separately as
              <code> thoughtsTokenCount</code>. If a reply stops with <code>MAX_TOKENS</code> after very few visible
              tokens, thinking consumed the budget: raise the budget or drop to low.
            </small>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Database size={19} />
          <div>
            <h2>Context cache</h2>
            <p>Reuse one paid copy of a conversation's files instead of resending them on every turn.</p>
          </div>
        </div>
        <div className="settings-grid">
          <label className="toggle-field">
            <input
              type="checkbox"
              checked={settings.cacheEnabled}
              onChange={(event) => updateSettings({ cacheEnabled: event.target.checked })}
            />
            <span>
              <strong>Use a context cache in chat</strong>
              <small>
                When a conversation carries files, chat creates a Vertex cache from them plus the system
                instruction, then sends only <code>cachedContent</code> and the new turn. Vertex AI only.
              </small>
            </span>
          </label>

          {settings.cacheEnabled ? (
            <div className="settings-warning">
              <AlertTriangle size={16} />
              <span>
                Cache creation and storage are billable, and this runs without asking first. Every cache below
                is charged until it expires or you delete it.
              </span>
            </div>
          ) : null}

          <label className="form-field">
            <span>Cache TTL (seconds)</span>
            <input
              type="number"
              min={60}
              step={60}
              value={settings.cacheTtlSeconds}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) updateSettings({ cacheTtlSeconds: Math.max(60, Math.round(value)) });
              }}
            />
            <small>Minimum 60 seconds. Storage is billed for the whole TTL, used or not.</small>
          </label>

          <CacheRegistryPanel />
        </div>
      </section>
    </div>
  );
}

function CacheRegistryPanel() {
  const [entries, setEntries] = useState<StoredCacheEntry[]>(() => loadCaches());
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setEntries(loadCaches());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function deleteCache(entry: StoredCacheEntry) {
    setBusy(entry.name);
    try {
      await fetch("/api/tests/cache/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: entry.name }),
      });
    } finally {
      setEntries(forgetCache(entry.name));
      setBusy(null);
    }
  }

  return (
    <div className="cache-registry">
      <div className="cache-registry-header">
        <strong>Caches created by this browser</strong>
        <span>{entries.length} live</span>
      </div>
      {entries.length === 0 ? (
        <p className="cache-registry-empty">
          None. Expired caches disappear from this list automatically, because Vertex has already stopped
          serving and billing them.
        </p>
      ) : (
        <ul className="cache-registry-list">
          {entries.map((entry) => (
            <li key={entry.name}>
              <div>
                <strong>{entry.displayName ?? entry.name.split("/").at(-1)}</strong>
                <span className="cache-registry-meta">
                  {entry.model} · {entry.region}
                  {entry.cachedTokens === undefined ? "" : ` · ${entry.cachedTokens.toLocaleString()} tokens`}
                </span>
                <span className="cache-registry-name">{entry.name}</span>
              </div>
              <div className="cache-registry-actions">
                <span className="cache-registry-ttl">{formatRemaining(remainingMs(entry, now))}</span>
                <button className="text-button" onClick={() => void deleteCache(entry)} disabled={busy === entry.name}>
                  {busy === entry.name ? "Deleting…" : "Delete"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
