import { PanelChat } from "../chat/PanelChat";

interface MonitorChatPanelProps {
  sessionId: string;
  className?: string;
}

export function MonitorChatPanel({ sessionId, className }: MonitorChatPanelProps) {
  return (
    <PanelChat
      chatId={sessionId}
      apiEndpoint="/api/monitor-chat"
      title="Monitor Builder"
      placeholder="Describe what to monitor..."
      persist
      className={className}
    />
  );
}
