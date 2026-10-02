import { useMemo } from "react";
import { trpc } from "../../lib/trpc";
import { PanelChat } from "../chat/PanelChat";

interface DashboardChatPanelProps {
  dashboardId: string;
  className?: string;
}

export function DashboardChatPanel({ dashboardId, className }: DashboardChatPanelProps) {
  const utils = trpc.useUtils();
  const extraBody = useMemo(() => ({ dashboardId }), [dashboardId]);

  return (
    <PanelChat
      chatId={`__dashboard__:${dashboardId}`}
      apiEndpoint="/api/dashboard-chat"
      title="Dashboard builder"
      placeholder="Describe a widget to add"
      extraBody={extraBody}
      onData={(part) => {
        if (part.type === "data-widget-changed") {
          utils.widgets.list.invalidate();
          utils.dashboards.list.invalidate();
        }
      }}
      className={className}
    />
  );
}
