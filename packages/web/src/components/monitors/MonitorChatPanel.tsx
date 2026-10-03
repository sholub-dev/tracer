import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "../../lib/trpc";
import { useParsedMessages } from "../../lib/chat-utils";
import { ChatCore, type ChatCoreRef } from "../chat/ChatCore";

interface MonitorChatPanelProps {
  sessionId: string;
  initialInput?: string;
}

export const MonitorChatPanel = forwardRef<ChatCoreRef, MonitorChatPanelProps>(function MonitorChatPanel({ sessionId, initialInput }, ref) {
  const utils = trpc.useUtils();
  const sessionQuery = trpc.sessions.get.useQuery({ id: sessionId }, { gcTime: 0 });
  const persistedMessages = useParsedMessages(sessionQuery.data?.messagesJson);

  if (sessionQuery.isLoading) {
    return (
      <div role="status" aria-label="Loading" className="flex flex-1 items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ChatCore
      ref={ref}
      key={sessionId}
      chatId={sessionId}
      initialMessages={persistedMessages}
      apiEndpoint="/api/monitor-chat"
      placeholder="e.g. Alert me when checkout errors pass 1% for 5 minutes"
      initialInput={initialInput}
      variant="panel"
      emptyHint={
        <p className="font-serif text-lg leading-[1.6] text-pretty">
          Tell me what to watch. I will write the query, test it on the last 24 hours, and show you whether it would fire right now.
        </p>
      }
      className="min-h-0 flex-1"
      onStatusChange={(status) => {
        if (status !== "ready") return;
        utils.monitors.builderChats.invalidate();
        utils.monitors.list.invalidate();
      }}
    />
  );
});
