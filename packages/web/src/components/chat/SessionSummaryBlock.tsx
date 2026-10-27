import { useRef, useState } from "react";
import { Copy, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { formatShortDate } from "../../lib/format";
import { Markdown } from "../../lib/markdown";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { FoldTrigger } from "../common/FoldTrigger";
import { IconButton } from "../common/IconButton";
import { copyText, extractMessageText } from "./MessageActions";
import { ANSWER_PROSE_COMPACT } from "./prose";

interface SessionSummaryBlockProps {
  summary: string;
  /** Number of messages the summary replaces (for the meta line). */
  summarizedCount?: number | null;
  /** Unix seconds. */
  createdAt?: number | null;
  showOriginals?: boolean;
  onToggleOriginals?: () => void;
  onSave?: (text: string) => Promise<void>;
  onDelete?: () => void;
  /** Display-only variant (e.g. while reconnected to a live stream). */
  readOnly?: boolean;
}

/** Compaction summary at the top of a compacted session; the summarized messages stay available behind "Show original messages". */
export function SessionSummaryBlock({
  summary,
  summarizedCount,
  createdAt,
  showOriginals = false,
  onToggleOriginals,
  onSave,
  onDelete,
  readOnly = false,
}: SessionSummaryBlockProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  const meta = [
    summarizedCount ? `${summarizedCount} ${summarizedCount === 1 ? "message" : "messages"} summarized` : null,
    createdAt ? formatShortDate(createdAt) : null,
  ].filter(Boolean);

  const save = async () => {
    const text = draft?.trim();
    if (!text || !onSave) return;
    setSaving(true);
    try {
      await onSave(text);
      setDraft(null);
    } catch {
      toast.error("Couldn't save the summary");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Collapsible open={open || draft !== null} onOpenChange={setOpen} className="group/summary rounded-lg border bg-card">
      <div className="flex items-center gap-2 pr-2">
        <FoldTrigger className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-4 py-3 text-left text-sm font-medium" chevronClassName="text-muted-foreground">
          Summary
          {meta.length > 0 && <span className="truncate font-normal text-muted-foreground">· {meta.join(" · ")}</span>}
        </FoldTrigger>
        {!readOnly && draft === null && (
          <div className="flex shrink-0 items-center gap-0.5 transition-opacity group-focus-within/summary:opacity-100 group-hover/summary:opacity-100 [@media(hover:hover)]:opacity-0">
            <IconButton label="Copy summary" size="icon-xs" className="text-muted-foreground" onClick={() => copyText(extractMessageText([{ type: "text", text: summary }]), "Summary copied")}>
              <Copy />
            </IconButton>
            {onSave && (
              <IconButton
                label="Edit summary"
                size="icon-xs"
                className="text-muted-foreground"
                onClick={() => {
                  setDraft(summary);
                  requestAnimationFrame(() => editorRef.current?.focus());
                }}
              >
                <Pencil />
              </IconButton>
            )}
            {onDelete && (
              <IconButton label="Delete summary" size="icon-xs" className="text-muted-foreground" onClick={() => setConfirmDelete(true)}>
                <Trash2 />
              </IconButton>
            )}
          </div>
        )}
      </div>
      <CollapsibleContent>
        <div className="border-t px-4 py-3">
          {draft !== null ? (
            <div className="space-y-2">
              <Textarea
                ref={editorRef}
                aria-label="Summary"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDraft(null);
                  }
                }}
                disabled={saving}
                className="max-h-[60svh] min-h-40 bg-background text-sm"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={save} disabled={saving || !draft.trim()}>{saving ? "Saving" : "Save"}</Button>
                <Button size="sm" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Markdown text={summary} className={ANSWER_PROSE_COMPACT} />
          )}
        </div>
      </CollapsibleContent>
      {!readOnly && onToggleOriginals && (
        <div className="border-t px-2 py-1.5">
          <Button variant="link" size="xs" className="text-muted-foreground" onClick={onToggleOriginals}>
            {showOriginals ? "Hide original messages" : "Show original messages"}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete the summary?"
        description="The next message uses the full conversation again. The original messages are not affected."
        actionLabel="Delete"
        onConfirm={() => onDelete?.()}
      />
    </Collapsible>
  );
}
