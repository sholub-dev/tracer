import { forwardRef, useRef } from "react";
import { Loader2 } from "lucide-react";
import { trpc } from "../../lib/trpc";
import { useParsedMessages } from "../../lib/chat-utils";
import { useOnResume } from "../../lib/resume";
import { ChatCore, type ChatCoreRef } from "../chat/ChatCore";
import { LiveStreamView } from "../chat/LiveStreamView";
import { SessionLoadError } from "../chat/SessionLoadError";

interface MonitorChatPanelProps {
  sessionId: string;
  initialInput?: string;
}

export const MonitorChatPanel = forwardRef<ChatCoreRef, MonitorChatPanelProps>(function MonitorChatPanel({ sessionId, initialInput }, ref) {
  const utils = trpc.useUtils();
  const sessionQuery = trpc.sessions.get.useQuery({ id: sessionId }, { gcTime: 0 });
  const persistedMessages = useParsedMessages(sessionQuery.data?.messagesJson);
  const truncateMessages = trpc.sessions.truncateMessages.useMutation();
  const ownRun = useRef(false);

  // The app was suspended: the run may have ended or started meanwhile. Skip while this chat streams itself.
  useOnResume(() => {
    if (!ownRun.current) void sessionQuery.refetch();
  });

  if (sessionQuery.isLoading) {
    return (
      <div role="status" aria-label="Loading" className="flex flex-1 items-center justify-center">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (sessionQuery.isError && !sessionQuery.data) {
    return <div className="min-h-0 flex-1"><SessionLoadError onRetry={() => void sessionQuery.refetch()} /></div>;
  }

  if (sessionQuery.data?.status === "streaming") {
    return (
      <div className="min-h-0 flex-1">
        <LiveStreamView key={sessionId} sessionId={sessionId} initialMessages={persistedMessages ?? []} onComplete={() => void sessionQuery.refetch()} />
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
      onRetryTruncate={async (keepCount) => { await truncateMessages.mutateAsync({ id: sessionId, keepCount }); }}
      onStatusChange={(status) => {
        ownRun.current = status === "submitted" || status === "streaming";
        if (status !== "ready") return;
        utils.monitors.builderChats.invalidate();
        utils.monitors.list.invalidate();
      }}
    />
  );
});
