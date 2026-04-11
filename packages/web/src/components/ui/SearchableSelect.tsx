import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";

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
  storageKey?: string;
  /** When true, the dropdown expands to fit content instead of matching button width. */
  fitContent?: boolean;
  /** When true, the button is non-interactive and visually dimmed. */
  disabled?: boolean;
}

export function useStarred(storageKey: string | undefined): [Set<string>, (value: string) => void] {
  const key = storageKey ? `oko:starred:${storageKey}` : null;
  const [starred, setStarred] = useState<Set<string>>(() => {
    if (!key) return new Set();
    try {
      const raw = localStorage.getItem(key);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  const toggle = (value: string) => {
    setStarred((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      if (key) localStorage.setItem(key, JSON.stringify([...next]));
      return next;
    });
  };

  return [starred, toggle];
}

export function SearchableSelect({ options, value, onChange, placeholder = "Select...", storageKey, fitContent, disabled }: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [starred, toggleStar] = useStarred(storageKey);
  const [pos, setPos] = useState({ top: 0, left: 0, minWidth: 0 });

  // Close on click outside the dropdown portal
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (buttonRef.current?.contains(e.target as Node)) return;
      if (dropdownRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Compute position from button rect
  const updatePos = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left, minWidth: rect.width });
  }, []);

  useEffect(() => {
    if (open) {
      updatePos();
      setSearch("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, updatePos]);

  const selected = options.find((o) => o.value === value);

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

  // Scroll selected into view on open
  useEffect(() => {
    if (open && value && listRef.current) {
      const el = listRef.current.querySelector(`[data-value="${CSS.escape(value)}"]`);
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }, [open, value]);

  const dropdown = open
    ? createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[100] bg-white border border-[#d4d2cd] rounded shadow-lg"
          style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth, width: fitContent ? "max-content" : pos.minWidth }}
        >
          <div className="p-1.5 border-b border-[#e8e6e1]">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search...`}
              className="w-full px-2 py-1.5 text-xs text-[#2c2c2c] font-sans bg-[#f5f4f0] border border-[#e8e6e1] rounded focus:outline-none focus:border-[#2b5ea7] placeholder:text-[#9c9890]"
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && filtered.length > 0) {
                  onChange(filtered[0].value);
                  setOpen(false);
                }
              }}
            />
          </div>
          <div ref={listRef} className="max-h-[280px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-xs text-[#9c9890] text-center">No projects found</div>
            ) : (
              filtered.map((opt) => {
                const isSelected = opt.value === value;
                const isStarred = starred.has(opt.value);
                return (
                  <div
                    key={opt.value}
                    data-value={opt.value}
                    className={`flex items-center gap-1.5 px-2 py-1.5 text-xs font-sans cursor-pointer transition-colors ${
                      isSelected
                        ? "bg-[#2b5ea7]/10 text-[#2b5ea7]"
                        : "text-[#2c2c2c] hover:bg-[#f5f4f0]"
                    }`}
                    onClick={() => { onChange(opt.value); setOpen(false); }}
                  >
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleStar(opt.value); }}
                      className={`shrink-0 w-4 h-4 flex items-center justify-center text-[10px] transition-colors ${
                        isStarred ? "text-[#d4a017]" : "text-[#d4d2cd] hover:text-[#9c9890]"
                      }`}
                      title={isStarred ? "Unstar" : "Star to pin to top"}
                    >
                      {isStarred ? "★" : "☆"}
                    </button>
                    <span className={fitContent ? "whitespace-nowrap" : "truncate flex-1"}>{opt.label}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="w-full bg-white border border-[#d4d2cd] rounded px-3 py-2 text-xs text-[#2c2c2c] font-sans text-left flex items-center justify-between focus:outline-none focus:border-[#2b5ea7] hover:border-[#b0ada6] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className={selected ? "text-[#2c2c2c] truncate" : "text-[#9c9890]"}>
          {selected ? (selected.displayLabel ?? selected.label) : placeholder}
        </span>
        <span className="text-[#9c9890] text-[10px] ml-2 shrink-0 transition-transform duration-200" style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}>
          ▾
        </span>
      </button>
      {dropdown}
    </>
  );
}
