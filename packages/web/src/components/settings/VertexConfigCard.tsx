import { useEffect, useMemo, useState } from "react";
import { theme } from "../../lib/theme";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { StatusIndicator } from "../ui/StatusIndicator";
import { Spinner } from "../ui/Spinner";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { SearchableSelect } from "../ui/SearchableSelect";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { useGcpAuthStatus } from "../../lib/hooks";

/**
 * Vertex AI is an LLM backend authenticated via gcloud ADC (no API key). The toggle enables
 * it; once on, it checks gcloud auth the same way the GCP data provider does — surfacing a
 * re-auth prompt when credentials are missing/expired rather than an empty project list — and
 * reveals the project + location pickers when authenticated.
 */
export function VertexConfigCard() {
  const utils = trpc.useUtils();
  const { data: existing, isLoading } = trpc.settings.getVertexConfig.useQuery();
  const authStatus = useGcpAuthStatus();

  const enabled = !!existing;
  const authData = authStatus.data;
  const authOk = authData?.ok ?? false;
  const connected = enabled && authOk;

  const invalidate = () => {
    utils.settings.getVertexConfig.invalidate();
    utils.provider.listVertexModels.invalidate();
  };
  const saveConfig = trpc.settings.saveVertexConfig.useMutation({ onSuccess: invalidate });
  const removeConfig = trpc.settings.removeVertexConfig.useMutation({ onSuccess: invalidate });
  const busy = saveConfig.isPending || removeConfig.isPending;

  const [confirmRemove, setConfirmRemove] = useState(false);

  // Only fetch projects once enabled and authenticated — listing requires gcloud auth.
  const { data: projects, isLoading: projectsLoading } = trpc.provider.listGcpProjects.useQuery(
    undefined,
    { staleTime: WEB_CONFIG.updateCheckStaleTimeMs, enabled: connected },
  );
  const projectOptions = useMemo(
    () => (projects ?? []).map((p) => ({
      value: p.projectId,
      label: p.name ? `${p.name} (${p.projectId})` : p.projectId,
      displayLabel: p.name || p.projectId,
    })),
    [projects],
  );

  function handleToggle(next: boolean) {
    if (next) {
      saveConfig.mutate({}); // enable — creates the row; project is picked below
    } else {
      setConfirmRemove(true);
    }
  }

  function handleRemove() {
    removeConfig.mutate();
    setConfirmRemove(false);
  }

  function handleProjectChange(projectId: string) {
    if (projectId === existing?.projectId) return;
    saveConfig.mutate({ projectId });
  }

  if (isLoading) return <div className="px-4 py-3"><Spinner size="sm" /></div>;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <ToggleSwitch
          checked={enabled}
          onChange={handleToggle}
          disabled={busy}
          aria-label="Enable Vertex AI"
        />
        <span className="text-sm font-medium">Vertex AI</span>
        {enabled ? (
          <StatusIndicator status={connected ? "connected" : "disconnected"} />
        ) : (
          <span className="text-xs opacity-40">Not configured</span>
        )}
      </div>

      {enabled && (
        <div className="mt-3 pt-3 border-t border-[#e8e6e1]">
          {authStatus.isLoading ? (
            <div className="flex items-center gap-2 text-xs text-[#666666]">
              <Spinner size="sm" /> Checking authentication…
            </div>
          ) : !authOk ? (
            <p className={theme.warnText}>
              {authData && !authData.ok
                ? authData.message
                : "Not authenticated. Run: gcloud auth application-default login"}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-xs text-[#666666] whitespace-nowrap w-14">Project</span>
                <div className="flex-1">
                  <SearchableSelect
                    options={projectOptions}
                    value={existing?.projectId ?? ""}
                    onChange={handleProjectChange}
                    placeholder={projectsLoading ? "Loading..." : "Select project..."}
                    storageKey="gcp-projectId"
                    fitContent
                    disabled={projectsLoading || busy}
                  />
                </div>
              </div>
              <LocationField
                value={existing?.location ?? "global"}
                onCommit={(location) => {
                  const loc = location.trim() || "global";
                  if (loc !== existing?.location) saveConfig.mutate({ location: loc });
                }}
                disabled={busy}
              />
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="Disable Vertex AI"
        message="Disable Vertex AI? Your project selection will be removed."
        confirmLabel="Disable"
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}

/** Text input that commits its value on blur / Enter (location rarely changes). */
function LocationField({
  value,
  onCommit,
  disabled,
}: {
  value: string;
  onCommit: (value: string) => void;
  disabled?: boolean;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-[#666666] whitespace-nowrap w-14">Location</span>
      <input
        type="text"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onCommit(local)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        placeholder="global"
        disabled={disabled}
        className={theme.input}
      />
    </div>
  );
}
