import { useEffect } from "react";
import { UNIFIED_SCOPE } from "@tracer-sh/shared";
import { GcpProjectPicker } from "@/components/common/GcpProjectPicker";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { providerLabel, sortProviders } from "../../lib/providers";
import { SegmentedControl } from "../common/SegmentedControl";
import { useProviderPings } from "../../lib/hooks";

/** Connected providers from the live ping; null while the first ping is in flight. */
export function useConnectedProviders() {
  const { data } = useProviderPings();
  return data ? sortProviders(data.filter((p) => p.ok)) : null;
}

interface SourcesToggleProps {
  activeProvider: string | null;
  onToggle: (type: string) => void;
}

export function SourcesToggle({ activeProvider, onToggle }: SourcesToggleProps) {
  const connected = useConnectedProviders();
  const { data: configs } = trpc.provider.getConfigs.useQuery(undefined, { staleTime: WEB_CONFIG.sourcesStaleMs });
  const connectedTypes = connected?.map((p) => p.type).join(",");
  const gcpConfig = configs?.find((c) => c.type === "gcp")?.config ?? null;

  // A provider that disconnected falls back to the always-valid unified scope.
  useEffect(() => {
    if (!connected?.length) return;
    if (activeProvider !== UNIFIED_SCOPE && !connected.some((p) => p.type === activeProvider)) onToggle(UNIFIED_SCOPE);
  }, [activeProvider, connectedTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!connected?.length) return null;

  const options = [{ value: UNIFIED_SCOPE, label: "All sources" }, ...connected.map((p) => ({ value: p.type, label: providerLabel(p.type, p.name) }))];

  return (
    <>
      <SegmentedControl label="Data sources" value={activeProvider ?? UNIFIED_SCOPE} onValueChange={onToggle} options={options} className="shrink-0" />
      {activeProvider === "gcp" && gcpConfig && (
        <GcpProjectPicker projectId={gcpConfig.projectId ?? ""} existingConfig={gcpConfig} />
      )}
    </>
  );
}
