import { useMemo } from "react";
import { trpc } from "../../lib/trpc";
import { SearchableSelect } from "../ui/SearchableSelect";

interface GcpProjectSelectorProps {
  existingConfig: Record<string, string>;
}

export function GcpProjectSelector({ existingConfig }: GcpProjectSelectorProps) {
  const utils = trpc.useUtils();
  const { data: projects, isLoading } = trpc.provider.listGcpProjects.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
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
