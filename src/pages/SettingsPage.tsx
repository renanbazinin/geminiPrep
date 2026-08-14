import { CheckCircle2, Cloud, KeyRound, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { ProviderId } from "../../shared/contracts";
import { useApp } from "../contexts/AppContext";
import { useConfig } from "../contexts/ConfigContext";

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
        </div>
      </section>
    </div>
  );
}
