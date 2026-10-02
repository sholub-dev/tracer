import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { TIME_RANGE_PRESETS } from "../../lib/nrql-utils";

type Preset = { readonly label: string; readonly since: string };

interface TimeRangePickerProps {
  value: string;
  onChange: (v: string) => void;
  presets?: readonly Preset[];
  className?: string;
}

export function TimeRangePicker({ value, onChange, presets, className }: TimeRangePickerProps) {
  const items = presets ?? TIME_RANGE_PRESETS;
  return (
    <ToggleGroup
      type="single"
      size="sm"
      spacing={0.5}
      aria-label="Time range"
      value={value}
      onValueChange={(v) => v && onChange(v)}
      className={cn("rounded-lg bg-muted p-0.5", className)}
    >
      {items.map((p) => (
        <ToggleGroupItem
          key={p.since}
          value={p.since}
          className="h-7 min-w-0 rounded-md px-2.5 text-xs font-medium tabular-nums text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-xs"
        >
          {p.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
