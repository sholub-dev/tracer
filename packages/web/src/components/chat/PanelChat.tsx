import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { ChatCore, type ChatCoreRef } from "./ChatCore";

interface PanelChatProps {
  chatId: string;
  apiEndpoint: string;
  title: string;
  placeholder: string;
  extraBody?: Record<string, unknown>;
  onData?: (part: { type: string; data: unknown }) => void;
  initialInput?: string;
  className?: string;
}

export function PanelChat({
  chatId,
  apiEndpoint,
  title,
  placeholder,
  extraBody,
  onData,
  initialInput,
  className,
}: PanelChatProps) {
  const [panelWidth, setPanelWidth] = useState(() => Math.floor((window.innerWidth - WEB_CONFIG.sidebarWidth) / 2));
  const coreRef = useRef<ChatCoreRef>(null);
  const utils = trpc.useUtils();
  const deleteSession = trpc.sessions.delete.useMutation();

  // Delete the stale server-side session on mount so the AI starts fresh.
  useEffect(() => {
    deleteSession.mutate({ id: chatId });
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // dragging left = wider
      const maxW = Math.floor((window.innerWidth - WEB_CONFIG.sidebarWidth) * WEB_CONFIG.panelMaxWidthRatio);
      setPanelWidth(Math.min(maxW, Math.max(WEB_CONFIG.panelMinWidth, startWidth + delta)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const [hasMessages, setHasMessages] = useState(false);

  const header = (
    <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-5">
      <h2 className="truncate text-sm font-semibold">{title}</h2>
      {hasMessages && (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          onClick={() => {
            coreRef.current?.setMessages([]);
            deleteSession.mutate({ id: chatId });
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );

  return (
    <div className={cn("relative flex shrink-0 flex-col overflow-hidden border-l bg-background", className)} style={{ width: panelWidth, maxWidth: panelWidth }}>
      <div
        aria-hidden="true"
        onMouseDown={handleResizeStart}
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-primary/20"
      />
      <ChatCore
        ref={coreRef}
        chatId={chatId}
        apiEndpoint={apiEndpoint}
        placeholder={placeholder}
        extraBody={extraBody}
        onData={onData}
        initialInput={initialInput}
        variant="panel"
        header={header}
        onStatusChange={(status, msgs) => {
          setHasMessages(msgs.length > 0);
          if (status === "ready") utils.sessions.list.invalidate();
        }}
      />
    </div>
  );
}
