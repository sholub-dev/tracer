import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { trpc } from "../../lib/trpc";
import { useStarred } from "./SearchableSelect";

export interface GcpProjectPickerProps {
  projectId: string;
  existingConfig: Record<string, string>;
}

export function GcpProjectPicker({ projectId, existingConfig }: GcpProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ bottom: 0, right: 0 });
  const [starred, toggleStar] = useStarred("gcp-projectId");

  const utils = trpc.useUtils();
  const { data: projects, isLoading } = trpc.provider.listGcpProjects.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const saveConfig = trpc.provider.saveConfig.useMutation({
    onSuccess: () => utils.provider.getConfigs.invalidate(),
  });

  const options = useMemo(
    () =>
      (projects ?? []).map((p) => ({
        value: p.projectId,
        label: p.name ? `${p.name} (${p.projectId})` : p.projectId,
      })),
    [projects],
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const matches = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    return [...matches].sort((a, b) => {
      const aS = starred.has(a.value) ? 0 : 1;
      const bS = starred.has(b.value) ? 0 : 1;
      if (aS !== bS) return aS - bS;
      return a.label.localeCompare(b.label);
    });
  }, [options, search, starred]);

  useEffect(() => {
    if (!open) return;
    const rect = buttonRef.current!.getBoundingClientRect();
    setPos({
      bottom: window.innerHeight - rect.top + 4,
      right: window.innerWidth - rect.right,
    });
    setSearch("");
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

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

  function select(value: string) {
    saveConfig.mutate({ type: "gcp", config: { ...existingConfig, projectId: value } });
    setOpen(false);
  }

  const dropdown = open
    ? createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[100] bg-white border border-[#d4d2cd] rounded shadow-lg w-72"
          style={{ bottom: pos.bottom, right: pos.right }}
        >
          <div className="p-1.5 border-b border-[#e8e6e1]">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects..."
              className="w-full px-2 py-1.5 text-xs font-sans bg-[#f5f4f0] border border-[#e8e6e1] rounded focus:outline-none focus:border-[#2b5ea7] placeholder:text-[#9c9890] text-[#2c2c2c]"
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && filtered.length > 0) select(filtered[0].value);
              }}
            />
          </div>
          <div className="max-h-[240px] overflow-y-auto">
            {isLoading ? (
              <div className="px-3 py-3 text-xs text-[#9c9890] text-center font-sans">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-3 text-xs text-[#9c9890] text-center font-sans">No projects found</div>
            ) : (
              filtered.map((opt) => {
                const isSelected = opt.value === projectId;
                const isStarred = starred.has(opt.value);
                return (
                  <div
                    key={opt.value}
                    className={`flex items-center gap-1.5 px-2 py-1.5 text-xs font-sans cursor-pointer transition-colors ${
                      isSelected ? "bg-[#2b5ea7]/10 text-[#2b5ea7]" : "text-[#2c2c2c] hover:bg-[#f5f4f0]"
                    }`}
                    onClick={() => select(opt.value)}
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
                    <span className="truncate flex-1">{opt.label}</span>
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
        onClick={() => setOpen((v) => !v)}
        className={`text-[10px] font-sans max-w-[16ch] truncate transition-colors ${
          open
            ? "text-[#2b5ea7]"
            : projectId
              ? "text-[#9c9890] hover:text-[#6b6560]"
              : "text-[#b0a898] hover:text-[#9c9890]"
        }`}
        title={projectId || "Select GCP project"}
      >
        {projectId || "select project"}
      </button>
      {dropdown}
    </>
  );
}
