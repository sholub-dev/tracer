import { useId } from "react";

import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/common/SearchableSelect";
import { useGcpProjectOptions } from "../../lib/hooks";

export function GcpProjectField({ value, onChange, disabled }: { value: string; onChange: (projectId: string) => void; disabled?: boolean }) {
  const id = useId();
  const { options, isLoading } = useGcpProjectOptions();

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[13px]/[18px]">
        Project
      </Label>
      <SearchableSelect
        id={id}
        options={options}
        value={value}
        onChange={(v) => v !== value && onChange(v)}
        placeholder={isLoading ? "Loading projects" : "Select project"}
        storageKey="gcp-projectId"
        fitContent
        disabled={isLoading || disabled}
      />
    </div>
  );
}

export function GcloudHint({ message }: { message?: string }) {
  return (
    <div className="space-y-1.5 text-[13px]/[18px]">
      <p className="text-warning">{message ?? "Not authenticated."}</p>
      <p className="text-muted-foreground">
        Sign in with <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs text-foreground">gcloud auth application-default login</code>
      </p>
    </div>
  );
}
