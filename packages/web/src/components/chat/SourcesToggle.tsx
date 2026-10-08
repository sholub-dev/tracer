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

/** The saved scope, or the always-valid unified scope while its provider is not connected. The saved choice stays untouched: one failed ping must not reset it. */
export function useEffectiveScope(activeProvider: string | null): string {
  const connected = useConnectedProviders();
  if (!activeProvider || activeProvider === UNIFIED_SCOPE || !connected || connected.some((p) => p.type === activeProvider)) return activeProvider ?? UNIFIED_SCOPE;
  return UNIFIED_SCOPE;
}

interface SourcesToggleProps {
  activeProvider: string | null;
  onToggle: (type: string) => void;
}

export function SourcesToggle({ activeProvider, onToggle }: SourcesToggleProps) {
  const connected = useConnectedProviders();
  const { data: configs } = trpc.provider.getConfigs.useQuery(undefined, { staleTime: WEB_CONFIG.sourcesStaleMs });
  const scope = useEffectiveScope(activeProvider);
  const gcpConfig = configs?.find((c) => c.type === "gcp")?.config ?? null;

  if (!connected?.length) return null;

  const options = [{ value: UNIFIED_SCOPE, label: "All sources" }, ...connected.map((p) => ({ value: p.type, label: providerLabel(p.type, p.name) }))];

  return (
    <>
      <SegmentedControl label="Data sources" value={scope} onValueChange={onToggle} options={options} className="shrink-0" />
      {scope === "gcp" && gcpConfig && (
        <GcpProjectPicker projectId={gcpConfig.projectId ?? ""} existingConfig={gcpConfig} />
      )}
    </>
  );
}
