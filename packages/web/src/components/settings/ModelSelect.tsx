import { theme } from "../../lib/theme";
import { providerLabel, groupModelsByProvider, modelKey, type ModelRef } from "../../lib/models";

interface ModelSelectProps {
  /** The currently-selected model (concrete provider+model). */
  value: ModelRef;
  /** Available models; grouped by provider in the dropdown. */
  models: ModelRef[];
  onChange: (model: ModelRef) => void;
  /** Models still being discovered — suppresses the "unavailable" warning during the window. */
  loading?: boolean;
  disabled?: boolean;
  /** Row label (left gutter). */
  label?: string;
}

/**
 * Grouped model picker: models are separated under provider headers (Anthropic / Google AI /
 * Vertex AI) and the current selection's provider is shown as a badge so the source is always
 * clear. A saved model that's no longer available is kept and flagged rather than silently
 * dropped — the server falls back to the default at runtime.
 */
export function ModelSelect({ value, models, onChange, loading, disabled, label = "Model" }: ModelSelectProps) {
  const groups = groupModelsByProvider(models);
  const valueKey = modelKey(value);
  const available = models.some((m) => modelKey(m) === valueKey);
  const showUnavailable = !available && !loading;

  function handleChange(key: string) {
    const idx = key.indexOf(":");
    onChange({ provider: key.slice(0, idx), modelId: key.slice(idx + 1) });
  }

  return (
    <div className="flex items-start gap-3 mt-3 pt-3 border-t border-[#d4d2cd]">
      <span className="text-xs text-[#666666] whitespace-nowrap w-14 mt-2">{label}</span>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium bg-[#f0eee9] text-[#666666] border border-[#d4d2cd]">
            {providerLabel(value.provider)}
          </span>
          <div className="relative flex-1">
            <select
              value={valueKey}
              onChange={(e) => handleChange(e.target.value)}
              disabled={disabled}
              className="w-full appearance-none bg-white border border-[#d4d2cd] rounded px-3 py-2 pr-7 text-xs text-[#2c2c2c] focus:outline-none focus:border-[#2b5ea7] font-sans disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {showUnavailable && (
                <optgroup label="Unavailable">
                  <option value={valueKey}>{providerLabel(value.provider)} · {value.modelId}</option>
                </optgroup>
              )}
              {groups.map((g) => (
                <optgroup key={g.provider} label={g.label}>
                  {g.models.map((m) => (
                    <option key={modelKey(m)} value={modelKey(m)}>{m.modelId}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[#9c9890] text-[10px]">▾</span>
          </div>
        </div>
        {showUnavailable && (
          <p className={theme.warnText + " mt-1.5"}>
            {providerLabel(value.provider)} · {value.modelId} isn’t available. Configure its provider or pick another model.
          </p>
        )}
      </div>
    </div>
  );
}
