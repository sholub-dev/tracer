import { theme } from "../../lib/theme";

export function MemoryItem({
  memory,
  editingId,
  editNote,
  setEditNote,
  onUpdate,
  onCancelEdit,
  onStartEdit,
  onDelete,
  updatePending,
  removePending,
}: {
  memory: { id: number; note: string; reviewNote: string | null; createdAt: number };
  editingId: number | null;
  editNote: string;
  setEditNote: (v: string) => void;
  onUpdate: (id: number) => void;
  onCancelEdit: () => void;
  onStartEdit: (id: number, note: string) => void;
  onDelete: (id: number) => void;
  updatePending: boolean;
  removePending: boolean;
}) {
  return (
    <li className="flex items-start justify-between gap-3 py-1.5 border-b border-[#d4d2cd] last:border-b-0">
      <div className="flex-1 min-w-0">
        {editingId === memory.id ? (
          <div className="space-y-2">
            <input
              type="text"
              value={editNote}
              onChange={(e) => setEditNote(e.target.value)}
              className={theme.input}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={() => onUpdate(memory.id)}
                disabled={!editNote || updatePending}
                className={theme.primaryBtn}
              >
                Save
              </button>
              <button
                onClick={onCancelEdit}
                disabled={updatePending}
                className={theme.secondaryBtn}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-[#444444]">{memory.note}</p>
            {memory.reviewNote && (
              <p className="text-xs text-[#9c9890] italic mt-0.5">{memory.reviewNote}</p>
            )}
            <p className="text-xs text-[#666666] mt-0.5">
              {new Date(memory.createdAt * 1000).toLocaleDateString()}
            </p>
          </>
        )}
      </div>
      {editingId !== memory.id && (
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onStartEdit(memory.id, memory.note)}
            className={theme.secondaryBtn}
          >
            Edit
          </button>
          <button
            onClick={() => onDelete(memory.id)}
            disabled={removePending}
            className={theme.dangerBtn}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
}
