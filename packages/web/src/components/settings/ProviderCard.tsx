import { theme } from "../../lib/theme";
import { StatusIndicator } from "../ui/StatusIndicator";
import { SubAgentModelSelector } from "./SubAgentModelSelector";
import { GcpProjectSelector } from "./GcpProjectSelector";
import { ToggleSwitch } from "../ui/ToggleSwitch";

interface ProviderCardProps {
  type: string;
  label: string;
  connected: boolean;
  configured: boolean;
  onConfigure: () => void;
  onToggle: (enabled: boolean) => void;
  togglePending?: boolean;
  toggleError?: string;
  pingError?: string;
  hasConfigFields: boolean;
  /** Saved config for this provider (used by inline selectors like GcpProjectSelector). */
  existingConfig?: Record<string, string>;
}

export function ProviderCard({ type, label, connected, configured, onConfigure, onToggle, togglePending, toggleError, pingError, hasConfigFields, existingConfig }: ProviderCardProps) {
  const active = configured || connected;

  return (
    <div className={theme.settingsCard + " w-80"}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <ToggleSwitch
            checked={configured}
            onChange={(enabled) => {
              if (enabled && hasConfigFields) {
                onConfigure();
              } else {
                onToggle(enabled);
              }
            }}
            disabled={togglePending}
          />
          <span className="font-medium">{label}</span>
          {active ? (
            <StatusIndicator status={connected ? "connected" : "disconnected"} />
          ) : (
            <span className="text-xs opacity-40">Not configured</span>
          )}
        </div>
        <button
          onClick={onConfigure}
          className={`${theme.secondaryBtn} ${configured && hasConfigFields ? "" : "invisible"}`}
        >
          Edit
        </button>
      </div>
      {active && <SubAgentModelSelector providerType={type} />}
      {active && type === "gcp" && existingConfig && (
        <GcpProjectSelector existingConfig={existingConfig} />
      )}
      {pingError && !connected && <p className={theme.warnText + " mt-2"}>{pingError}</p>}
      {toggleError && <p className={theme.errorText + " mt-2"}>{toggleError}</p>}
    </div>
  );
}
