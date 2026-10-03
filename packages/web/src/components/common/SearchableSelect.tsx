import { useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePersistedState } from "../../lib/hooks";

interface Option {
  value: string;
  label: string;
  /** If set, shown in the button when this option is selected instead of label. */
  displayLabel?: string;
}

interface SearchableSelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** localStorage key for starred items. */
  storageKey: string;
  /** When true, the dropdown expands to fit content instead of matching button width. */
  fitContent?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

function useStarred(storageKey: string): [Set<string>, (value: string) => void] {
  const [list, setList] = usePersistedState<string[]>(`tracer:starred:${storageKey}`, []);
  const starred = useMemo(() => new Set(list), [list]);
  const toggle = (value: string) => setList(starred.has(value) ? list.filter((v) => v !== value) : [...list, value]);
  return [starred, toggle];
}

interface SearchableOptionsProps {
  options: Option[];
  value: string;
  onSelect: (value: string) => void;
  storageKey: string;
  loading?: boolean;
  searchLabel?: string;
}

/** Search box plus a starred-first option list, for use inside a PopoverContent. */
export function SearchableOptions({ options, value, onSelect, storageKey, loading, searchLabel = "Search" }: SearchableOptionsProps) {
  const [search, setSearch] = useState("");
  const [starred, toggleStar] = useStarred(storageKey);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const matches = q
      ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
      : options;
    return [...matches].sort((a, b) => {
      const aS = starred.has(a.value) ? 0 : 1;
      const bS = starred.has(b.value) ? 0 : 1;
      if (aS !== bS) return aS - bS;
      return a.label.localeCompare(b.label);
    });
  }, [options, search, starred]);

  let body: ReactNode;
  if (loading) body = <p className="px-3 py-3 text-center text-[13px] text-muted-foreground">Loading</p>;
  else if (filtered.length === 0) body = <p className="px-3 py-3 text-center text-[13px] text-muted-foreground">No matches</p>;
  else
    body = (
      <ul role="listbox" aria-label={searchLabel} className="max-h-72 overflow-y-auto p-1">
        {filtered.map((opt) => {
          const selected = opt.value === value;
          const isStarred = starred.has(opt.value);
          return (
            <li key={opt.value} role="option" aria-selected={selected} className="group/opt flex items-center gap-0.5 rounded-sm hover:bg-accent">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={isStarred ? `Unstar ${opt.label}` : `Star ${opt.label}`}
                    aria-pressed={isStarred}
                    onClick={() => toggleStar(opt.value)}
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      isStarred ? "text-warning" : "text-muted-foreground/60 hover:text-muted-foreground",
                    )}
                  >
                    <Star className={cn("size-3.5", isStarred && "fill-current")} aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{isStarred ? "Unstar" : "Star to pin to top"}</TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={() => onSelect(opt.value)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1.5 pr-2 text-left text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                {selected && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
    );

  return (
    <>
      <div className="border-b p-1.5">
        <Input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search"
          aria-label={searchLabel}
          className="h-8 text-[13px]"
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered.length > 0) {
              e.preventDefault();
              onSelect(filtered[0].value);
            }
          }}
        />
      </div>
      {body}
    </>
  );
}

export function SearchableSelect({ options, value, onChange, placeholder = "Select", storageKey, fitContent, disabled, id, className }: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn("w-full justify-between bg-card px-2.5 font-normal", className)}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? (selected.displayLabel ?? selected.label) : placeholder}
          </span>
          <ChevronDown className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("p-0", fitContent ? "w-auto max-w-[min(32rem,90vw)] min-w-(--radix-popover-trigger-width)" : "w-(--radix-popover-trigger-width)")}
      >
        <SearchableOptions
          options={options}
          value={value}
          storageKey={storageKey}
          onSelect={(v) => {
            onChange(v);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
