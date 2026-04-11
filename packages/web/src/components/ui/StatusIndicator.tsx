import { theme } from "../../lib/theme";

interface StatusIndicatorProps {
  status: "connected" | "disconnected" | "checking";
  label?: string;
}

export function StatusIndicator({ status, label }: StatusIndicatorProps) {
  return (
    <div className="flex items-center gap-2">
      <span className={`inline-block h-2 w-2 rounded-full ${theme.statusDot[status]}`} />
      {label && <span className={theme.statusLabel}>{label}</span>}
    </div>
  );
}
