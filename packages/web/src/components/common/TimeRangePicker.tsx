import { TIME_RANGE_PRESETS } from "../../lib/nrql-utils";
import { SegmentedControl } from "./SegmentedControl";

type Preset = { readonly label: string; readonly since: string };

interface TimeRangePickerProps {
  value: string;
  onChange: (v: string) => void;
  presets?: readonly Preset[];
  className?: string;
}

export function TimeRangePicker({ value, onChange, presets = TIME_RANGE_PRESETS, className }: TimeRangePickerProps) {
  return (
    <SegmentedControl
      label="Time range"
      value={value}
      onValueChange={onChange}
      options={presets.map((p) => ({ value: p.since, label: p.label }))}
      className={className}
      itemClassName="tabular-nums"
    />
  );
}
