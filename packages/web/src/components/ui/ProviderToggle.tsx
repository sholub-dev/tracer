import { useEffect, useState } from "react";
import { trpc } from "../../lib/trpc";
import { theme } from "../../lib/theme";
import { GcpProjectPicker } from "./GcpProjectPicker";

const SHORT_LABELS: Record<string, string> = {
  newrelic: "NR",
  gcp: "GCP",
};

const PROVIDER_ORDER: Record<string, number> = { gcp: 0, newrelic: 1 };
function sortProviders<T extends { type: string }>(providers: T[]): T[] {
  return [...providers].sort(
    (a, b) => (PROVIDER_ORDER[a.type] ?? 99) - (PROVIDER_ORDER[b.type] ?? 99),
  );
}

// ── ProviderToggle ─────────────────────────────────────────────────────────

interface ProviderToggleProps {
  activeProvider: string | null;
  onToggle: (type: string) => void;
}

export function ProviderToggle({ activeProvider, onToggle }: ProviderToggleProps) {
  const { data, isLoading } = trpc.provider.ping.useQuery(undefined, {
    staleTime: 30_000,
    refetchOnMount: "always",
  });

  const { data: configs } = trpc.provider.getConfigs.useQuery(undefined, {
    staleTime: 60_000,
  });

  const connected = sortProviders(data?.filter((p) => p.ok) ?? []);
  const gcpConfig = configs?.find((c) => c.type === "gcp")?.config ?? null;
  const gcpProjectId = gcpConfig?.projectId ?? "";

  // Auto-default to first connected provider
  useEffect(() => {
    if (!activeProvider && connected.length > 0) {
      onToggle(connected[0].type);
    }
  }, [activeProvider, connected.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading || connected.length === 0) return null;

  const showGcpPicker = connected.some((p) => p.type === "gcp") && gcpConfig !== null;

  if (connected.length === 1) {
    const p = connected[0];
    return (
      <div className="flex items-center gap-2">
        {showGcpPicker ? (
          <GcpProjectPicker projectId={gcpProjectId} existingConfig={gcpConfig} />
        ) : (
          <span className="invisible text-[10px]">·</span>
        )}
        <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-sans rounded border border-[#c4c0b8] bg-[#ede9e3] text-[#4a4540]">
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${theme.statusDot.connected}`} />
          {SHORT_LABELS[p.type] ?? p.type.toUpperCase()}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      {showGcpPicker && (
        <span
          className={`mr-0.5 transition-opacity ${activeProvider === "gcp" ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <GcpProjectPicker projectId={gcpProjectId} existingConfig={gcpConfig} />
        </span>
      )}
      {connected.map((p) => {
        const isActive = activeProvider === p.type;
        return (
          <button
            key={p.type}
            type="button"
            onClick={() => onToggle(p.type)}
            title={`${p.name}: ${isActive ? "active" : "click to switch"}`}
            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-sans rounded border transition-all ${
              isActive
                ? "border-[#c4c0b8] bg-[#ede9e3] text-[#4a4540] shadow-[inset_0_1px_2px_rgba(0,0,0,0.1)]"
                : "border-[#e0dbd3] text-[#b0a898] hover:text-[#6b6560] hover:border-[#c4c0b8]"
            }`}
          >
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full ${
                isActive ? theme.statusDot.connected : "bg-[#d4d0c8]"
              }`}
            />
            {SHORT_LABELS[p.type] ?? p.type.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
