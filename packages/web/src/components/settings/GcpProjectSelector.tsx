import { useMemo } from "react";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { SearchableSelect } from "../ui/SearchableSelect";
import { useGcpAuthStatus } from "../../lib/hooks";

interface GcpProjectSelectorProps {
  existingConfig: Record<string, string>;
}

export function GcpProjectSelector({ existingConfig }: GcpProjectSelectorProps) {
  const utils = trpc.useUtils();
  const authStatus = useGcpAuthStatus();
  const { data: projects, isLoading } = trpc.provider.listGcpProjects.useQuery(undefined, {
    staleTime: WEB_CONFIG.updateCheckStaleTimeMs,
  });
  const saveConfig = trpc.provider.saveConfig.useMutation({
    onSuccess: () => {
      utils.provider.getConfigs.invalidate();
      utils.provider.list.invalidate();
    },
  });

  const options = useMemo(
    () => (projects ?? []).map((p) => ({
      value: p.projectId,
      label: p.name ? `${p.name} (${p.projectId})` : p.projectId,
      displayLabel: p.name || p.projectId,
    })),
    [projects],
  );

  const currentProjectId = existingConfig.projectId ?? "";

  // When gcloud auth is missing/expired the project list is empty and meaningless; hide the
  // selector and let the card's connection error explain why (avoids a blank dropdown).
  if (authStatus.data && !authStatus.data.ok) return null;

  function handleChange(value: string) {
    if (value === currentProjectId) return;
    saveConfig.mutate({ type: "gcp", config: { ...existingConfig, projectId: value } });
  }

  return (
    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-[#d4d2cd]">
      <span className="text-xs text-[#666666] whitespace-nowrap w-14">Project</span>
      <div className="flex-1">
        <SearchableSelect
          options={options}
          value={currentProjectId}
          onChange={handleChange}
          placeholder={isLoading ? "Loading..." : "Select project..."}
          storageKey="gcp-projectId"
          fitContent
          disabled={isLoading || saveConfig.isPending}
        />
      </div>
    </div>
  );
}
