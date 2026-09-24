import { useState, useRef, useEffect, useCallback } from "react";
import type { UIMessage } from "ai";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { ChatCore, type ChatCoreRef } from "./ChatCore";
import { Spinner } from "../ui/Spinner";

interface PanelChatProps {
  chatId: string;
  apiEndpoint: string;
  title: string;
  placeholder: string;
  extraBody?: Record<string, unknown>;
  onData?: (part: { type: string; data: unknown }) => void;
  className?: string;
  /** Keep the server session across mounts and resume it instead of starting fresh. */
  persist?: boolean;
}

export function PanelChat({
  chatId,
  apiEndpoint,
  title,
  placeholder,
  extraBody,
  onData,
  className,
  persist = false,
}: PanelChatProps) {
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.floor((window.innerWidth - WEB_CONFIG.sidebarWidth) / 2),
  );
  const coreRef = useRef<ChatCoreRef>(null);
  const utils = trpc.useUtils();
  const deleteSession = trpc.sessions.delete.useMutation();

  // Delete stale server-side session on mount so AI starts fresh
  useEffect(() => {
    if (!persist) deleteSession.mutate({ id: chatId });
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessionQuery = trpc.sessions.get.useQuery({ id: chatId }, { enabled: persist, gcTime: 0 });

  const panelWidthRef = useRef(panelWidth);
  panelWidthRef.current = panelWidth;

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;
    const onMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX; // dragging left = wider
      const contentWidth = window.innerWidth - WEB_CONFIG.sidebarWidth;
      const maxW = Math.floor(contentWidth * WEB_CONFIG.panelMaxWidthRatio);
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
  }, []); // stable — reads panelWidth from ref

  // Track messages for clear button visibility (re-renders on ref change via status)
  const [hasMessages, setHasMessages] = useState(false);

  const header = (
    <div className={theme.dashboardChatHeader}>
      <span className={theme.dashboardChatTitle}>{title}</span>
      {!persist && hasMessages && (
        <button
          type="button"
          onClick={() => {
            coreRef.current?.setMessages([]);
            deleteSession.mutate({ id: chatId });
          }}
          className={theme.dashboardChatToggle}
        >
          Clear
        </button>
      )}
    </div>
  );

  return (
    <div
      className={`${theme.dashboardChat} ${className ?? ""}`}
      style={{ width: panelWidth, maxWidth: panelWidth }}
    >
      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[#2b5ea7]/20 transition-colors z-10"
      />
      {persist && sessionQuery.isLoading ? (
        <>
          {header}
          <Spinner centered />
        </>
      ) : (
        <ChatCore
          key={persist ? chatId : undefined}
          ref={coreRef}
          chatId={chatId}
          initialMessages={persist ? (sessionQuery.data?.messages as UIMessage[] | undefined) : undefined}
          apiEndpoint={apiEndpoint}
          placeholder={placeholder}
          extraBody={extraBody}
          onData={onData}
          variant="panel"
          header={header}
          onStatusChange={(status, msgs) => {
            setHasMessages(msgs.length > 0);
            if (status === "ready") {
              utils.sessions.list.invalidate();
            }
          }}
        />
      )}
    </div>
  );
}
