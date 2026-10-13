import { useApp } from "../contexts/AppContext";
import { useConfig } from "../contexts/ConfigContext";
import { PRO_MODEL, PRO_MODEL_LABEL } from "../../shared/gemini-4";

/** Switches chat to the Gemini 4 Pro model and back. The saved model is kept for when it turns off. */
export function ProModelToggle({ disabled = false }: { disabled?: boolean }) {
  const { settings, updateSettings } = useApp();
  const { config } = useConfig();
  const available = config?.providers[settings.provider].models.some((model) => model.id === PRO_MODEL.id) ?? false;
  const on = settings.proModel;
  const title = !available
    ? `${PRO_MODEL_LABEL} is not available from this server`
    : on
      ? `Using ${PRO_MODEL.id}. Turn off to return to ${settings.models[settings.provider]}.`
      : `Switch chat to ${PRO_MODEL.id}`;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${PRO_MODEL_LABEL} Pro model`}
      className={`pro-toggle${on ? " pro-toggle-on" : ""}`}
      disabled={disabled || !available}
      title={title}
      onClick={() => updateSettings({ proModel: !on })}
    >
      <span className="pro-toggle-track" aria-hidden="true"><span className="pro-toggle-thumb" /></span>
      <span>{PRO_MODEL_LABEL}</span>
      <span className="pro-toggle-pill" aria-hidden="true">Pro</span>
    </button>
  );
}
