import { useRef, useState } from "react";
import { ChevronRight, Copy, Pencil, Trash2 } from "lucide-react";
import { Streamdown } from "streamdown";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { MD_CONTROLS, MD_LINK_SAFETY } from "../../lib/markdown";
import { IconButton } from "./IconButton";
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
    createdAt ? new Date(createdAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null,
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
        <CollapsibleTrigger className="group/trigger flex min-w-0 flex-1 items-center gap-2 rounded-lg px-4 py-3 text-left text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-[state=open]/trigger:rotate-90" aria-hidden="true" />
          Summary
          {meta.length > 0 && <span className="truncate font-normal text-muted-foreground">· {meta.join(" · ")}</span>}
        </CollapsibleTrigger>
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
            <div className={ANSWER_PROSE_COMPACT}>
              <Streamdown isAnimating={false} controls={MD_CONTROLS} linkSafety={MD_LINK_SAFETY}>{summary}</Streamdown>
            </div>
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

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the summary?</AlertDialogTitle>
            <AlertDialogDescription>
              The next message uses the full conversation again. The original messages are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onDelete?.()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  );
}
