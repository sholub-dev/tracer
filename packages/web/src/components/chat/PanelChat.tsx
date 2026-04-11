import { useState, useRef, useEffect, useCallback } from "react";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { ChatCore, type ChatCoreRef } from "./ChatCore";

const SIDEBAR_WIDTH = 208; // w-52 in Shell.tsx
const MIN_WIDTH = 260;
const MAX_WIDTH_RATIO = 0.8; // never exceed 80% of content area

interface PanelChatProps {
  chatId: string;
  apiEndpoint: string;
  title: string;
  placeholder: string;
  extraBody?: Record<string, unknown>;
  onData?: (part: { type: string; data: unknown }) => void;
  className?: string;
}

export function PanelChat({
  chatId,
  apiEndpoint,
  title,
  placeholder,
  extraBody,
  onData,
  className,
}: PanelChatProps) {
  const [panelWidth, setPanelWidth] = useState(() =>
    Math.floor((window.innerWidth - SIDEBAR_WIDTH) / 2),
  );
  const coreRef = useRef<ChatCoreRef>(null);
  const utils = trpc.useUtils();
  const deleteSession = trpc.sessions.delete.useMutation();

  // Delete stale server-side session on mount so AI starts fresh
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
      const contentWidth = window.innerWidth - SIDEBAR_WIDTH;
      const maxW = Math.floor(contentWidth * MAX_WIDTH_RATIO);
      setPanelWidth(Math.min(maxW, Math.max(MIN_WIDTH, startWidth + delta)));
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
      {hasMessages && (
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
      <ChatCore
        ref={coreRef}
        chatId={chatId}
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
    </div>
  );
}
