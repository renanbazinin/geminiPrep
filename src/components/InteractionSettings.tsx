import { useEffect, useState } from "react";
import { MessagesSquare } from "lucide-react";
import type { InteractionOptions } from "../../shared/contracts";
import { IMAGE_ASPECT_RATIOS, parseInteractionOptions, usesInteractions } from "../../shared/interactions";
import { useApp } from "../contexts/AppContext";

export function InteractionSettings() {
  const { settings, updateSettings } = useApp();
  const options = settings.interactions;
  const vertex = settings.provider === "vertex";
  const [stopText, setStopText] = useState(options.stopSequences.join("\n"));
  useEffect(() => {
    setStopText((current) => current.split("\n").filter(Boolean).join("\n") === options.stopSequences.join("\n")
      ? current : options.stopSequences.join("\n"));
  }, [options.stopSequences]);
  const set = (patch: Partial<InteractionOptions>) => updateSettings({ interactions: { ...options, ...patch } });
  let error = "";
  try { parseInteractionOptions(options); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  const toggle = (key: "googleSearch" | "urlContext" | "codeExecution", label: string, help: string) => (
    <label className="toggle-field" key={key}>
      <input type="checkbox" checked={options[key]} onChange={(event) => set({ [key]: event.target.checked })} />
      <span><strong>{label}</strong><small>{help}</small></span>
    </label>
  );
  return (
    <section className="settings-section" id="conversation-api">
      <div className="settings-section-title"><MessagesSquare size={19} aria-hidden="true" /><div><h2>Conversation API</h2><p>Choose how Gemini remembers the conversation and which capabilities it can use.</p></div></div>
      <label className="form-field">
        <span>{vertex ? "Vertex API mode" : "Gemini API mode"}</span>
        <select value={vertex ? settings.vertexApi : settings.geminiApi} onChange={(event) => updateSettings(vertex ? { vertexApi: event.target.value as typeof settings.vertexApi } : { geminiApi: event.target.value as typeof settings.geminiApi })}>
          <option value="interactions">Interactions — persistent conversations</option>
          <option value="generateContent">Generate Content — legacy chat and automatic image routing</option>
        </select>
      </label>
      {usesInteractions(settings) ? <>
        <div className="settings-grid interaction-settings-grid">
          {vertex ? <div className="form-field form-field-static"><span>API version</span><strong>v1beta1 · Google Cloud Preview</strong><small>Uses project credentials, with no Gemini API key. Stored interactions expire after 7 days; local history can restore them.</small></div> : <label className="form-field"><span>API version</span>
            <select value={options.apiVersion} onChange={(event) => set({ apiVersion: event.target.value as InteractionOptions["apiVersion"] })}>
              <option value="v1">v1 — stable</option><option value="v1beta">v1beta — preview features</option>
            </select>
            <small>Changing API version or model starts a fresh chain using local history.</small>
          </label>}
          <label className="form-field"><span>Conversation memory</span>
            <select value={options.stateful ? "stateful" : "history"} onChange={(event) => set(event.target.value === "stateful" ? { stateful: true, store: true } : { stateful: false })}>
              <option value="stateful">Stateful — continue the stored interaction</option><option value="history">Send full local history every turn</option>
            </select>
            <small>Stateful follow-ups send only new input. Existing chats are imported on their first turn.</small>
          </label>
          <label className="toggle-field">
            <input type="checkbox" checked={options.store} onChange={(event) => set({ store: event.target.checked, ...(!event.target.checked ? { stateful: false } : {}) })} />
            <span><strong>Store interactions with Google</strong><small>Required for stateful memory. Turning this off also switches to full local history. It does not delete earlier stored interactions.</small></span>
          </label>
          <p className="form-field form-field-wide settings-help">If Google rejects an expired or invalid conversation ID, chat restores the conversation from local history and retries once. Missing local files stop recovery with a clear message. Local deletion removes only this browser's copy. {vertex ? "Stored IDs are scoped to your Google Cloud project. Changing provider or project starts a new chain from local history." : <>Manage Google's retained interactions in <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer">AI Studio</a>.</>}</p>
        </div>

        <h3>Reasoning and output</h3>
        <div className="settings-grid">
          <label className="form-field"><span>Interaction thinking level</span>
            <select value={options.thinkingLevel} onChange={(event) => set({ thinkingLevel: event.target.value as InteractionOptions["thinkingLevel"] })}>
              {(["default", "minimal", "low", "medium", "high"] as const).map((level) => <option key={level} value={level}>{level === "default" ? "Model default" : level}</option>)}
            </select><small>Supported levels vary by model. Model default leaves the choice to Gemini.</small>
          </label>
          <label className="form-field"><span>Thinking summaries</span>
            <select value={options.thinkingSummaries} onChange={(event) => set({ thinkingSummaries: event.target.value as InteractionOptions["thinkingSummaries"] })}>
              <option value="none">Hidden</option><option value="auto">Show available summaries</option>
            </select><small>Displays the summaries supplied by Gemini in a collapsible section.</small>
          </label>
          <label className="form-field"><span>Seed (optional)</span>
            <input type="number" step={1} min={-2147483648} max={2147483647} value={options.seed ?? ""} placeholder="Model default" onChange={(event) => set({ seed: event.target.value === "" ? null : Number(event.target.value) })} />
            <small>Best-effort reproducibility; identical output is not guaranteed.</small>
          </label>
          <label className="form-field"><span>{vertex ? "Top P (optional)" : "Top P (beta only)"}</span>
            <input type="number" min={0} max={1} step={0.01} disabled={!vertex && options.apiVersion !== "v1beta"} value={options.topP ?? ""} placeholder="Model default" onChange={(event) => set({ topP: event.target.value === "" ? null : Number(event.target.value) })} />
            <small>{vertex ? "Controls the cumulative probability of tokens considered when sampling." : "Deprecated in beta; omitted with stable v1, like temperature."}</small>
          </label>
          <label className="form-field"><span>Stop sequences</span>
            <textarea rows={3} value={stopText} placeholder="One sequence per line" onChange={(event) => { setStopText(event.target.value); set({ stopSequences: event.target.value.split("\n").filter(Boolean) }); }} />
            <small>Up to 5 sequences, 200 characters each. Matching text ends generation.</small>
          </label>
          <label className="form-field"><span>Response format</span>
            <select value={options.responseFormat} onChange={(event) => set({ responseFormat: event.target.value as InteractionOptions["responseFormat"] })}>
              <option value="text">Text / Markdown</option><option value="json">JSON</option>
            </select><small>JSON applies to text chat. Image requests use the image settings below.</small>
          </label>
          {options.responseFormat === "json" ? <label className="form-field form-field-wide"><span>JSON response schema (optional)</span>
            <textarea rows={7} maxLength={20_000} spellCheck={false} value={options.responseSchema} placeholder={'{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}'} onChange={(event) => set({ responseSchema: event.target.value })} />
            <small>Use a JSON Schema object supported by the selected model.</small>
          </label> : null}
        </div>

        <h3>Tools</h3>
        <div className="settings-grid">
          {toggle("googleSearch", "Google Search", "Allow Gemini to look up current information on the web.")}
          {toggle("urlContext", "URL context", "Allow Gemini to read public pages referenced in your messages.")}
          {toggle("codeExecution", "Code execution", "Allow Gemini to run Python in Google's execution environment.")}
          <label className="form-field"><span>Tool choice</span>
            <select value={options.toolChoice} onChange={(event) => set({ toolChoice: event.target.value as InteractionOptions["toolChoice"] })}>
              <option value="auto">Auto</option><option value="none">Do not use tools</option><option value="any">Require a tool</option><option value="validated">Validated</option>
            </select><small>Tool support and allowed combinations depend on the model. Tool usage can add charges.</small>
          </label>
          <p className="form-field form-field-wide settings-help">Use the Image button in chat for image generation, or Graph for a Mermaid diagram. Automatic image handoff remains available in Generate Content mode.</p>
        </div>

        <h3>Image generation</h3>
        <div className="settings-grid">
          <label className="form-field"><span>Image aspect ratio</span><select value={options.imageAspectRatio} onChange={(event) => set({ imageAspectRatio: event.target.value })}>{IMAGE_ASPECT_RATIOS.map((ratio) => <option key={ratio}>{ratio}</option>)}</select></label>
          <label className="form-field"><span>Image size</span><select value={options.imageSize} onChange={(event) => set({ imageSize: event.target.value as InteractionOptions["imageSize"] })}>{["512", "1K", "2K", "4K"].map((size) => <option key={size}>{size}</option>)}</select><small>Availability and cost depend on the image model.</small></label>
        </div>
        {error ? <p className="panel-error" role="alert">{error}</p> : <p className="settings-help">Settings save automatically and apply to your next message.</p>}
      </> : null}
    </section>
  );
}
