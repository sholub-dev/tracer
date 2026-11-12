import { memo, type ReactNode } from "react";
import type { UIMessage } from "ai";
import type { ProgressStore } from "../../lib/progress-store";
import type { AskState } from "../../lib/ask-card";
import { ErrorBoundary } from "../ErrorBoundary";
import { MessageView, type MessageViewOptions } from "./MessageView";

export type RenderView = (options?: MessageViewOptions) => ReactNode;

// Memoized so a streaming chunk only re-renders the row whose message object changed.
// The live view and the saved view both draw their rows here, so a reply keeps one structure from stream to save.
export const MessageRow = memo(function MessageRow({
  msg,
  msgIndex,
  isAnimating,
  progressStore,
  compact,
  renderMessage,
  piece,
  ask,
  onAsk,
}: {
  msg: UIMessage;
  msgIndex: number;
  isAnimating: boolean;
  progressStore: ProgressStore;
  compact: boolean;
  renderMessage?: (msg: UIMessage, index: number, view: RenderView) => ReactNode;
  /** A piece of a reply that a steered message cut apart, not its last one. */
  piece?: boolean;
  ask?: AskState;
  onAsk?: (label: string) => void;
}) {
  const view: RenderView = (options) => (
    <MessageView msg={msg} isAnimating={isAnimating} progressStore={progressStore} compact={compact} ask={ask} onAsk={onAsk} showActions={piece ? false : undefined} {...options} />
  );
  // No content-visibility here: a skipped reply takes its real height only as it scrolls into view, and that moves the view under the reader.
  return (
    <div data-role={msg.role}>
      <ErrorBoundary resetKey={msg}>{renderMessage ? renderMessage(msg, msgIndex, view) : view()}</ErrorBoundary>
    </div>
  );
});
