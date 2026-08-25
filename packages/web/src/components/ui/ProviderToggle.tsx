import { useEffect } from "react";
import { UNIFIED_SCOPE } from "@tracer-sh/shared";
import { trpc } from "../../lib/trpc";
import { theme } from "../../lib/theme";
import { WEB_CONFIG } from "../../lib/config";
import { GcpProjectPicker } from "./GcpProjectPicker";

const SHORT_LABELS: Record<string, string> = {
  newrelic: "NR",
  gcp: "GCP",
  posthog: "PH",
  [UNIFIED_SCOPE]: "ALL",
};

const PROVIDER_ORDER: Record<string, number> = { gcp: 0, newrelic: 1, posthog: 2 };
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
  const { data, isLoading } = trpc.provider.ping.useQuery();

  const { data: configs } = trpc.provider.getConfigs.useQuery(undefined, {
    staleTime: WEB_CONFIG.monitorPollingMs,
  });

  const connected = sortProviders(data?.filter((p) => p.ok) ?? []);
  const connectedTypes = connected.map((p) => p.type).join(",");
  const gcpConfig = configs?.find((c) => c.type === "gcp")?.config ?? null;
  const gcpProjectId = gcpConfig?.projectId ?? "";

  // Correct a stale/invalid selection (a provider that disconnected). The cross-provider
  // "ALL" (unified) scope is always valid, and is the default everyone starts on.
  useEffect(() => {
    if (connected.length === 0) return;
    const valid =
      activeProvider === UNIFIED_SCOPE ||
      connected.some((p) => p.type === activeProvider);
    if (!valid) onToggle(UNIFIED_SCOPE);
  }, [activeProvider, connectedTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data && isLoading) return null;
  if (connected.length === 0) return null;

  const showGcpPicker = connected.some((p) => p.type === "gcp") && gcpConfig !== null;

  // Effective options = the cross-provider "ALL" chip plus every connected provider.
  const options: Array<{ type: string; name: string }> = [
    { type: UNIFIED_SCOPE, name: "Unified" },
    ...connected,
  ];

  return (
    <div className="flex items-center gap-1.5">
      {showGcpPicker && (
        <span
          className={`mr-0.5 transition-opacity ${activeProvider === "gcp" ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <GcpProjectPicker projectId={gcpProjectId} existingConfig={gcpConfig} />
        </span>
      )}
      {options.map((p) => {
        const isActive = activeProvider === p.type;
        const isUnified = p.type === UNIFIED_SCOPE;
        return (
          <button
            key={p.type}
            type="button"
            onClick={() => onToggle(p.type)}
            title={
              isUnified
                ? `Unified: one agent with every connected provider's query tools in one session${isActive ? " (active)" : ""}`
                : `${p.name}: ${isActive ? "active" : "click to switch"}`
            }
            className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-sans rounded border transition-all ${
              isActive
                ? "border-[#c4c0b8] bg-[#ede9e3] text-[#4a4540] shadow-[inset_0_1px_2px_rgba(0,0,0,0.1)]"
                : "border-[#e0dbd3] text-[#b0a898] hover:text-[#6b6560] hover:border-[#c4c0b8]"
            }`}
          >
            {/* Unified gets a square accent (not a connection dot — it is a scope, not a provider). */}
            <span
              className={`inline-block w-1.5 h-1.5 ${
                isUnified
                  ? `rounded-[1px] ${isActive ? "bg-[#2b5ea7]" : "bg-[#b9c4d4]"}`
                  : `rounded-full ${isActive ? theme.statusDot.connected : "bg-[#d4d0c8]"}`
              }`}
            />
            {SHORT_LABELS[p.type] ?? p.type.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
