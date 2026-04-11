import { trpc } from "../../lib/trpc";
import { PanelChat } from "../chat/PanelChat";

interface MonitorChatPanelProps {
  className?: string;
}

export function MonitorChatPanel({ className }: MonitorChatPanelProps) {
  const utils = trpc.useUtils();

  return (
    <PanelChat
      chatId="__monitors__"
      apiEndpoint="/api/monitor-chat"
      title="Monitor Builder"
      placeholder="Create a monitor..."
      onData={(part) => {
        if (part.type === "data-monitor-changed") {
          utils.monitors.list.invalidate();
          utils.monitorAlerts.activeAlerts.invalidate();
          utils.monitorAlerts.activeCount.invalidate();
        }
      }}
      className={className}
    />
  );
}
