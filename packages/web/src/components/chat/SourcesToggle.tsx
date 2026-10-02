import { useEffect } from "react";
import { UNIFIED_SCOPE } from "@tracer-sh/shared";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { GcpProjectPicker } from "@/components/ui/GcpProjectPicker";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { providerLabel, sortProviders } from "../../lib/providers";

/** Connected providers from the live ping; null while the first ping is in flight. */
export function useConnectedProviders() {
  const { data } = trpc.provider.ping.useQuery();
  return data ? sortProviders(data.filter((p) => p.ok)) : null;
}

interface SourcesToggleProps {
  activeProvider: string | null;
  onToggle: (type: string) => void;
}

export function SourcesToggle({ activeProvider, onToggle }: SourcesToggleProps) {
  const connected = useConnectedProviders();
  const { data: configs } = trpc.provider.getConfigs.useQuery(undefined, { staleTime: WEB_CONFIG.monitorPollingMs });
  const connectedTypes = connected?.map((p) => p.type).join(",");
  const gcpConfig = configs?.find((c) => c.type === "gcp")?.config ?? null;

  // A provider that disconnected falls back to the always-valid unified scope.
  useEffect(() => {
    if (!connected?.length) return;
    if (activeProvider !== UNIFIED_SCOPE && !connected.some((p) => p.type === activeProvider)) onToggle(UNIFIED_SCOPE);
  }, [activeProvider, connectedTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!connected?.length) return null;

  const options = [{ type: UNIFIED_SCOPE, label: "All sources" }, ...connected.map((p) => ({ type: p.type, label: providerLabel(p.type, p.name) }))];

  return (
    <>
      <ToggleGroup
        type="single"
        size="sm"
        spacing={0.5}
        aria-label="Data sources"
        value={activeProvider ?? UNIFIED_SCOPE}
        onValueChange={(v) => v && onToggle(v)}
        className="shrink-0 rounded-lg bg-muted p-0.5"
      >
        {options.map((o) => (
          <ToggleGroupItem
            key={o.type}
            value={o.type}
            className="h-7 min-w-0 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-xs"
          >
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {activeProvider === "gcp" && gcpConfig && (
        <GcpProjectPicker projectId={gcpConfig.projectId ?? ""} existingConfig={gcpConfig} />
      )}
    </>
  );
}
