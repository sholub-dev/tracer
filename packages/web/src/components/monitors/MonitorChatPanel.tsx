import { PanelChat } from "../chat/PanelChat";

interface MonitorChatPanelProps {
  sessionId: string;
  initialInput?: string;
}

export function MonitorChatPanel({ sessionId, initialInput }: MonitorChatPanelProps) {
  return (
    <PanelChat
      chatId={sessionId}
      apiEndpoint="/api/monitor-chat"
      title="Monitor Builder"
      placeholder="Describe what to monitor..."
      persist
      initialInput={initialInput}
    />
  );
}
