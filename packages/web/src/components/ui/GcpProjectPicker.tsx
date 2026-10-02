import { useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchableOptions } from "@/components/ui/SearchableSelect";
import { cn } from "@/lib/utils";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";

interface GcpProjectPickerProps {
  projectId: string;
  existingConfig: Record<string, string>;
}

export function GcpProjectPicker({ projectId, existingConfig }: GcpProjectPickerProps) {
  const [open, setOpen] = useState(false);

  const utils = trpc.useUtils();
  const { data: projects, isLoading } = trpc.provider.listGcpProjects.useQuery(undefined, {
    staleTime: WEB_CONFIG.updateCheckStaleTimeMs,
    enabled: open,
  });
  const saveConfig = trpc.provider.saveConfig.useMutation({
    onSuccess: () => utils.provider.getConfigs.invalidate(),
  });

  const options = useMemo(
    () => (projects ?? []).map((p) => ({ value: p.projectId, label: p.name ? `${p.name} (${p.projectId})` : p.projectId })),
    [projects],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={projectId || "Select GCP project"}
          className={cn(
            "max-w-[16ch] truncate rounded-sm text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
            open && "text-primary",
          )}
        >
          {projectId || "select project"}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-72 p-0">
        <SearchableOptions
          options={options}
          value={projectId}
          loading={isLoading}
          storageKey="gcp-projectId"
          searchLabel="Search projects"
          onSelect={(value) => {
            saveConfig.mutate({ type: "gcp", config: { ...existingConfig, projectId: value } });
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
