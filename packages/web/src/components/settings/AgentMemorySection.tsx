import { useState } from "react";
import { theme } from "../../lib/theme";
import { Spinner } from "../ui/Spinner";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { trpc } from "../../lib/trpc";
import { MemoryItem } from "./MemoryItem";

export function AgentMemorySection() {
  const utils = trpc.useUtils();
  const { data: memories, isLoading } = trpc.memory.list.useQuery();
  const { data: registeredTypes } = trpc.provider.getRegisteredTypes.useQuery();
  const createMemory = trpc.memory.create.useMutation({
    onSuccess: () => {
      utils.memory.list.invalidate();
      setNewNote("");
      setNewProvider("orchestrator");
      setShowAddForm(false);
    },
  });
  const updateMemory = trpc.memory.update.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  });
  const removeMemory = trpc.memory.remove.useMutation({
    onSuccess: () => utils.memory.list.invalidate(),
  });
  const [optimizeResult, setOptimizeResult] = useState<{ kept: number; updated: number; deleted: number } | null>(null);
  const optimizeMemory = trpc.memory.optimize.useMutation({
    onSuccess: (data) => {
      utils.memory.list.invalidate();
      setOptimizeResult(data.stats);
    },
  });

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editNote, setEditNote] = useState("");
  const [deleteMemoryId, setDeleteMemoryId] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newProvider, setNewProvider] = useState("orchestrator");
  const [newNote, setNewNote] = useState("");

  function startEdit(id: number, note: string) {
    setEditingId(id);
    setEditNote(note);
  }

  async function handleUpdate(id: number) {
    await updateMemory.mutateAsync({ id, note: editNote });
    setEditingId(null);
    setEditNote("");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditNote("");
  }

  const providerOptions = [
    { value: "orchestrator", label: "Orchestrator" },
    ...(registeredTypes ?? []).map((t) => ({ value: t.type, label: t.label })),
  ];

  const VISIBLE_COUNT = 5;

  if (isLoading) return <Spinner size="lg" centered />;

  // Group memories by tool name
  const grouped = new Map<string, NonNullable<typeof memories>>();
  if (memories) {
    for (const memory of memories) {
      const group = grouped.get(memory.toolName) ?? [];
      group.push(memory);
      grouped.set(memory.toolName, group);
    }
  }

  const memoryItemProps = {
    editingId,
    editNote,
    setEditNote,
    onUpdate: handleUpdate,
    onCancelEdit: cancelEdit,
    onStartEdit: startEdit,
    onDelete: (id: number) => setDeleteMemoryId(id),
    updatePending: updateMemory.isPending,
    removePending: removeMemory.isPending,
  };

  return (
    <div className="space-y-4">
      {/* Add Memory button / form */}
      {!showAddForm ? (
        <button
          onClick={() => setShowAddForm(true)}
          className={theme.secondaryBtn}
        >
          + Add Memory
        </button>
      ) : (
        <div className={theme.settingsCard + " space-y-3"}>
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-[#666666] font-sans">Provider</label>
            <select
              value={newProvider}
              onChange={(e) => { setNewProvider(e.target.value); e.target.blur(); }}
              className="bg-white border border-[#d4d2cd] rounded px-3 py-2 pr-8 text-sm text-[#2c2c2c] focus:outline-none focus:border-[#2b5ea7] font-sans appearance-none bg-[length:16px_16px] bg-[right_8px_center] bg-no-repeat"
              style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23666666' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E")` }}
            >
              {providerOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={theme.sectionTitle}>Note</label>
            <input
              type="text"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newNote.trim() && !createMemory.isPending) createMemory.mutate({ toolName: newProvider, note: newNote }); }}
              placeholder="Reusable lesson or pattern..."
              className={theme.input}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => createMemory.mutate({ toolName: newProvider, note: newNote })}
              disabled={!newNote.trim() || createMemory.isPending}
              className={theme.primaryBtn}
            >
              {createMemory.isPending ? (
                <span className="flex items-center gap-2">
                  <Spinner size="sm" /> Saving...
                </span>
              ) : (
                "Save"
              )}
            </button>
            <button
              onClick={() => { setShowAddForm(false); setNewNote(""); setNewProvider("orchestrator"); }}
              disabled={createMemory.isPending}
              className={theme.secondaryBtn}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {grouped.size === 0 && (
        <div className={theme.settingsCard}>
          <p className="text-sm text-[#666666]">
            No memories yet. The agent will save notes here as it learns from tool
            usage.
          </p>
        </div>
      )}

      {[...grouped.entries()].map(([toolName, items]) => {
        const hasOverflow = items.length > VISIBLE_COUNT;

        return (
          <div key={toolName} className={theme.settingsCard}>
            <div className="mb-3 flex items-center gap-2">
              <span className={`${theme.badge} ${theme.badgeVariants.info}`}>
                {toolName}
              </span>
              {hasOverflow && (
                <span className="text-xs text-[#666666]">
                  {items.length} memories
                </span>
              )}
              <button
                onClick={() => optimizeMemory.mutate({ toolName })}
                disabled={optimizeMemory.isPending || items.length === 0}
                className={`ml-auto ${theme.outlineBtn}`}
                title="Optimize memories with AI"
              >
                {optimizeMemory.isPending && optimizeMemory.variables?.toolName === toolName ? (
                  <span className="flex items-center gap-1">
                    <Spinner size="sm" /> Optimizing...
                  </span>
                ) : (
                  "Optimize"
                )}
              </button>
            </div>
            <ul className={`space-y-2${hasOverflow ? " max-h-64 overflow-y-auto" : ""}`}>
              {items.map((memory) => (
                <MemoryItem key={memory.id} memory={memory} {...memoryItemProps} />
              ))}
            </ul>
          </div>
        );
      })}

      <ConfirmDialog
        open={deleteMemoryId !== null}
        title="Delete memory"
        message="Delete this agent memory?"
        onConfirm={() => {
          if (deleteMemoryId !== null) removeMemory.mutate({ id: deleteMemoryId });
          setDeleteMemoryId(null);
        }}
        onCancel={() => setDeleteMemoryId(null)}
      />

      <ConfirmDialog
        open={optimizeResult !== null}
        title="Optimization Complete"
        message={
          optimizeResult && (
            <div className="space-y-1.5 text-sm text-[#444444]">
              <p>Kept: <span className="font-medium">{optimizeResult.kept}</span></p>
              <p>Updated: <span className="font-medium">{optimizeResult.updated}</span></p>
              <p>Deleted: <span className="font-medium">{optimizeResult.deleted}</span></p>
            </div>
          )
        }
        confirmLabel="OK"
        cancelLabel={null}
        confirmStyle="primary"
        onConfirm={() => setOptimizeResult(null)}
        onCancel={() => setOptimizeResult(null)}
      />
    </div>
  );
}
