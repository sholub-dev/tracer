import { useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { UIMessage } from "ai";
import { theme } from "../../lib/theme";
import { CopyMessageButton } from "./CopyMessageButton";
import { ConfirmDialog } from "../ui/ConfirmDialog";

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

/**
 * Compaction summary block shown at the top of a compacted session. The
 * summarized messages are hidden from the list but never deleted — the
 * "show original messages" toggle reveals them below this block.
 */
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
  const [expanded, setExpanded] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const copyParts = useMemo<UIMessage["parts"]>(
    () => [{ type: "text", text: summary }],
    [summary],
  );

  const meta: string[] = [];
  if (summarizedCount) {
    meta.push(`${summarizedCount} message${summarizedCount === 1 ? "" : "s"} summarized`);
  }
  if (createdAt) {
    meta.push(new Date(createdAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  }

  const handleStartEdit = () => {
    setDraft(summary);
    setSaveError(null);
    setEditing(true);
    setExpanded(true);
  };

  const handleSave = async () => {
    const text = draft.trim();
    if (!text || !onSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(text);
      setEditing(false);
    } catch {
      setSaveError("Failed to save summary");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`${theme.compactionContainer} relative group/summary`}>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-baseline gap-2 min-w-0 text-left"
          title={expanded ? "Collapse summary" : "Expand summary"}
        >
          <span className={`${theme.compactionLabel} mb-0`}>Summary</span>
          {meta.length > 0 && (
            <span className="text-[11px] text-[#9c9890] font-sans truncate">{meta.join(" · ")}</span>
          )}
          <ChevronIcon open={expanded} />
        </button>
        {!readOnly && !editing && (
          <div className="flex items-center gap-0.5 opacity-0 group-hover/summary:opacity-100 transition-opacity">
            {/* Copy-as-image needs the body rendered — hidden while collapsed */}
            {expanded && <CopyMessageButton contentRef={bodyRef} parts={copyParts} size={12} />}
            {onSave && (
              <button
                type="button"
                onClick={handleStartEdit}
                className={theme.chatActionButton}
                title="Edit summary"
                aria-label="Edit summary"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  <path d="m15 5 4 4" />
                </svg>
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className={theme.chatActionButton}
                title="Delete summary"
                aria-label="Delete summary"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={14}
            className={`${theme.chatEditTextarea} text-sm font-sans`}
            disabled={saving}
          />
          <div className={theme.chatEditActions}>
            <button type="button" onClick={handleSave} disabled={saving || !draft.trim()} className={theme.chatEditSave}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={saving} className={theme.chatEditCancel}>
              Cancel
            </button>
            {saveError && <span className="text-xs text-[#b33a2a] font-sans">{saveError}</span>}
          </div>
        </div>
      ) : (
        expanded && (
          <div ref={bodyRef} className="mt-2 text-sm text-[#2c2c2c] leading-relaxed">
            <Streamdown isAnimating={false} controls={{ code: true }} linkSafety={{ enabled: false }}>
              {summary}
            </Streamdown>
          </div>
        )
      )}

      {!readOnly && onToggleOriginals && (
        <button
          type="button"
          onClick={onToggleOriginals}
          className="mt-1.5 text-[11px] font-sans text-[#8a6d3b] hover:underline"
        >
          {showOriginals ? "Hide original messages" : "Show original messages"}
        </button>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete summary?"
        message="The summary will be removed and the next message will use the full conversation history again. The original messages are unaffected."
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete?.();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 self-center text-[#9c9890] transition-transform ${open ? "rotate-180" : ""}`}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
