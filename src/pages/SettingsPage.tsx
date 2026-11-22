import { AlertTriangle, CheckCircle2, Cloud, Database, FileStack, KeyRound, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import type { LargeFilesConfig, LargeFilesOverrides, ProviderId, StoredCacheEntry, ThinkingLevel } from "../../shared/contracts";
import { useApp } from "../contexts/AppContext";
import { useConfig } from "../contexts/ConfigContext";
import { forgetCache, formatRemaining, loadCaches, remainingMs } from "../lib/cache-registry";
import { InteractionSettings } from "../components/InteractionSettings";
import { usesInteractions } from "../../shared/interactions";
import { GEMINI_4_MIN_OUTPUT_TOKENS, PRO_MODEL, PRO_MODEL_LABEL, gemini4RegionProblem } from "../../shared/gemini-4";
import { largeFilesBounds } from "../lib/large-files-limits";

export function SettingsPage() {
  const { settings, updateSettings, resetSettings, storageError } = useApp();
  const { config, loading, error, reload } = useConfig();
  const interactionMode = usesInteractions(settings);
  const modelManagedSampling = settings.proModel
    || (interactionMode && settings.provider === "gemini" && settings.interactions.apiVersion === "v1");
  const proModelAvailable = config?.providers[settings.provider].models.some((model) => model.id === PRO_MODEL.id) ?? false;
  const proRegionProblem = settings.proModel && settings.provider === "vertex" && !interactionMode
    ? gemini4RegionProblem(settings.region)
    : null;

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
      {storageError ? <p className="panel-error" role="alert">{storageError}</p> : null}

      <section className="interactions-overview" aria-label="Stateful chat settings">
        <div>
          <p className="eyebrow">GEMINI INTERACTIONS</p>
          <h2>Conversations that remember</h2>
          <p>{interactionMode ? (settings.interactions.stateful ? "Stateful memory is on. Follow-ups continue your stored conversation." : "Interactions is on. Each turn sends your local conversation history.") : "Enable persistent Gemini conversations, recovery from expired IDs, and advanced reasoning and tool controls."}</p>
        </div>
        {interactionMode ? <a className="secondary-button" href="#conversation-api">Memory, tools & advanced settings</a> : (
          <button className="primary-button" onClick={() => {
            updateSettings(settings.provider === "vertex" ? { vertexApi: "interactions" } : { geminiApi: "interactions" });
          }}>Use Gemini Interactions</button>
        )}
      </section>

      {error ? (
        <div className="panel-error" role="alert">
          <span>{error}</span>
          <button onClick={reload}>Try again</button>
        </div>
      ) : null}

      <section className="settings-section">
        <div className="settings-section-title">
          <Cloud size={19} />
          <div><h2>Provider</h2><p>Use stateful Interactions with your Google Cloud project or a Gemini Developer API key.</p></div>
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
              disabled={!config || settings.proModel}
            >
              {/* The Pro model has its own toggle below rather than a menu entry. */}
              {(config?.providers[settings.provider].models ?? [])
                .filter((model) => model.id !== PRO_MODEL.id || model.id === settings.models[settings.provider])
                .map((model) => (
                  <option key={model.id} value={model.id}>{model.label} · {model.id}</option>
                ))}
            </select>
            {settings.proModel ? <small>{PRO_MODEL_LABEL} is on. Turn it off to use this model again.</small> : null}
          </label>

          {settings.provider === "vertex" && interactionMode ? (
            <div className="form-field form-field-static"><span>Google Cloud endpoint</span><strong>{config?.project ?? "Project not configured"} · global</strong><small>Interactions uses your server's Google Cloud credentials. Preview is available on the global endpoint.</small></div>
          ) : settings.provider === "vertex" ? (
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

          <label className="toggle-field">
            <input
              type="checkbox"
              checked={settings.proModel}
              disabled={!proModelAvailable}
              onChange={(event) => updateSettings({ proModel: event.target.checked })}
            />
            <span>
              <strong>Use {PRO_MODEL_LABEL} (Pro model)</strong>
              <small>
                Sends <code>{PRO_MODEL.id}</code> instead of the model above, on both API modes. Paid tier only.
                Thinking counts toward the output limit, so at least {GEMINI_4_MIN_OUTPUT_TOKENS.toLocaleString()} output
                tokens are requested. Temperature and Top P are not sent, and minimal thinking runs as low.
                {settings.provider === "vertex" ? " Vertex serves it from global, us, and eu." : ""}
              </small>
            </span>
          </label>
          {proRegionProblem ? (
            <div className="settings-warning" role="alert">
              <AlertTriangle size={16} />
              <span>{proRegionProblem}</span>
            </div>
          ) : null}

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
              disabled={modelManagedSampling}
              onChange={(event) => updateSettings({ temperature: Number(event.target.value) })}
            />
            <small>{settings.proModel
              ? `${PRO_MODEL_LABEL} manages its own sampling; temperature is not sent.`
              : modelManagedSampling ? "Stable Interactions v1 uses model-managed sampling; temperature is not sent." : "Lower is more consistent; higher is more varied."}</small>
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
            <small>{settings.proModel && settings.maxOutputTokens < GEMINI_4_MIN_OUTPUT_TOKENS
              ? `${PRO_MODEL_LABEL} raises this to ${GEMINI_4_MIN_OUTPUT_TOKENS.toLocaleString()} so thinking leaves room for the answer.`
              : "Provider/model limits may be lower than this local guardrail."}</small>
          </label>

          {!interactionMode ? <label className="form-field">
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
          </label> : null}
        </div>
      </section>

      <InteractionSettings />

      {settings.provider === "vertex" && !interactionMode ? <section className="settings-section">
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
      </section> : null}

      {config?.largeFiles ? <LargeFilesSettings limits={config.largeFiles} /> : null}
    </div>
  );
}

type LargeFilesField = keyof LargeFilesOverrides;

const formatMb = (bytes: number) => `${Number((bytes / 1024 / 1024).toFixed(1)).toLocaleString()} MB`;

function LargeFilesSettings({ limits }: { limits: LargeFilesConfig }) {
  const { settings, updateSettings } = useApp();
  const overrides = settings.largeFiles ?? {};
  const bounds = largeFilesBounds(limits);
  const npm = limits.engine === "npm";
  const customized = Object.values(overrides).some((value) => typeof value === "number");

  function set(field: LargeFilesField, value: number | null) {
    updateSettings({ largeFiles: { ...overrides, [field]: value } });
  }

  /**
   * Empty is the server's value. A number is capped at the maximum while typing, and raised to the
   * minimum when the field is left, so typing "2000" into a field whose minimum is 1,000 still works.
   * A value saved above what this server now allows stays saved (the server may raise its limit
   * again) and is shown with the limit that applies instead.
   */
  function numberInput(field: LargeFilesField, step: number, round: (value: number) => number, unit: string) {
    const { min, max, server } = bounds[field];
    const value = overrides[field];
    const aboveMax = typeof value === "number" && value > max;
    return (
      <>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value ?? ""}
          placeholder={`Server default: ${server.toLocaleString()}`}
          onChange={(event) => {
            if (event.target.value === "") return set(field, null);
            const next = Number(event.target.value);
            if (Number.isFinite(next)) set(field, Math.min(max, Math.max(0, round(next))));
          }}
          onBlur={() => {
            if (typeof value === "number" && value < min) set(field, min);
          }}
        />
        {aboveMax ? (
          <small className="provider-warning">
            This server allows at most {max.toLocaleString()} {unit}, so it uses {max.toLocaleString()} instead of your {value.toLocaleString()}.
          </small>
        ) : null}
      </>
    );
  }

  return (
    <section className="settings-section">
      <div className="settings-section-title">
        <FileStack size={19} />
        <div>
          <h2>Large files</h2>
          <p>Choose which attachments go to the server, and when the model searches a file instead of reading all of it.</p>
        </div>
      </div>
      <div className="settings-grid">
        <label className="form-field">
          <span>Upload text, DOCX and PPTX above (KB)</span>
          {numberInput("serverThresholdKb", 1, Math.round, "KB")}
          <small>
            Smaller files stay in this browser and are sent with each question. From {bounds.serverThresholdKb.min.toLocaleString()} to
            {" "}{bounds.serverThresholdKb.max.toLocaleString()} KB.
          </small>
        </label>

        <label className="form-field">
          <span>Upload PDFs above (MB)</span>
          {numberInput("pdfInlineMaxMb", 0.1, (value) => Math.round(value * 10) / 10, "MB")}
          <small>
            Smaller PDFs are sent whole, so Gemini sees their layout and pictures. Up to {bounds.pdfInlineMaxMb.max.toLocaleString()} MB,
            the most this server leaves room for in a request.
          </small>
        </label>

        <label className="form-field">
          <span>Search files above (tokens)</span>
          {numberInput("inlineTokens", 1000, Math.round, "tokens")}
          <small>
            This browser uploads each file with more text than this. On the server, files are read in full, smallest first,
            while their text together stays under this amount and fits the model's context; the rest are searched with tools.
            From {bounds.inlineTokens.min.toLocaleString()} to {bounds.inlineTokens.max.toLocaleString()} tokens.
          </small>
        </label>

        <div className="form-field form-field-static">
          <span>Server limits</span>
          <strong>{formatMb(limits.maxUploadBytes)} per file · kept {limits.ttlHours.toLocaleString()} hours</strong>
          <small>
            Engine: {limits.engine === "npm" ? "llm-large-files (npm)" : limits.engine === "original" ? "original" : "not reported by this server"}.
            Set on the server; uploaded files are deleted after this time.
          </small>
        </div>

        <p className="form-field form-field-wide settings-help">
          Empty fields use the server's values.{" "}
          {npm
            ? "A lower token threshold is also sent with each question, and the server plans with it. The server counts tokens again on the text it prepares, so a file uploaded for its length is usually searched there too. Files already attached stay where they are (in this browser or on the server), but the token threshold applies at each question to every file on the server, including ones you attached earlier."
            : `This server's engine plans with its own token threshold (${limits.inlineTokens.toLocaleString()}); a lower value here uploads more files, but the server may still send them whole. Files already attached keep the routing they were given; new thresholds apply to files you attach next.`}
        </p>

        <div className="form-field-wide">
          <button className="secondary-button" disabled={!customized} onClick={() => updateSettings({ largeFiles: undefined })}>
            <RotateCcw size={16} /> Use server defaults
          </button>
        </div>
      </div>
    </section>
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
