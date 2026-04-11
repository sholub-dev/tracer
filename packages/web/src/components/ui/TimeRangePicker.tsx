import { TIME_RANGE_PRESETS } from "../../lib/nrql-utils";
import { theme } from "../../lib/theme";

type Preset = { readonly label: string; readonly since: string };

export function TimeRangePicker({ value, onChange, presets }: { value: string; onChange: (v: string) => void; presets?: readonly Preset[] }) {
  const items = presets ?? TIME_RANGE_PRESETS;
  return (
    <div className="flex gap-1">
      {items.map((p) => (
        <button
          key={p.since}
          type="button"
          onClick={() => onChange(p.since)}
          className={`px-2 py-0.5 text-xs font-sans rounded-sm transition-colors ${
            value === p.since
              ? theme.timePickerActive
              : theme.timePickerInactive
          }`}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
