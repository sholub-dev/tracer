import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "../common/IconButton";
import type { Attachment } from "./Composer";

export type QueuedMessage = { id: number; text: string; attachments: Attachment[] };

interface QueuedMessagesProps {
  items: QueuedMessage[];
  /** A reply runs, so a queued message can steer it; otherwise it can only be sent. */
  running: boolean;
  onAct: (item: QueuedMessage) => void;
  onRemove: (item: QueuedMessage) => void;
}

export function QueuedMessages({ items, running, onAct, onRemove }: QueuedMessagesProps) {
  if (items.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-col gap-1.5" aria-label="Queued messages">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-2 rounded-lg border bg-card py-1 pr-1 pl-3 text-sm">
          <span className="shrink-0 text-xs font-medium text-ink-2">Queued</span>
          <span className="min-w-0 flex-1 truncate">
            {item.text}
            {item.attachments.length > 0 && <span className="text-muted-foreground"> +{item.attachments.length} file{item.attachments.length > 1 ? "s" : ""}</span>}
          </span>
          {/* A file cannot ride along with a steer. */}
          <Button variant="ghost" size="xs" disabled={running && item.attachments.length > 0} onClick={() => onAct(item)}>
            {running ? "Steer now" : "Send now"}
          </Button>
          <IconButton label="Remove queued message" size="icon-xs" onClick={() => onRemove(item)}>
            <X />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}
