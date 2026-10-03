import { useMemo, useState } from "react";
import { Loader2, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatShortDate } from "../../lib/format";
import { providerLabel } from "../../lib/providers";
import { trpc } from "../../lib/trpc";
import { ProviderDot } from "../common/ProviderDot";
import { SegmentedControl } from "../common/SegmentedControl";
import { ConfirmButton, Section } from "./parts";

const PAGE = 10;
const ALL = "all";

type Memory = { id: number; toolName: string; note: string; reviewNote: string | null; createdAt: number };

export function MemorySettings() {
  const utils = trpc.useUtils();
  const { data: memories, isLoading } = trpc.memory.list.useQuery();
  const { data: types } = trpc.provider.getRegisteredTypes.useQuery();
  const optimize = trpc.memory.optimize.useMutation({
    onSuccess: (data, { toolName }) => {
      utils.memory.list.invalidate();
      const { kept, updated, deleted } = data.stats;
      if (data.success) toast.success(`Optimized ${labelOf(toolName)}: kept ${kept}, updated ${updated}, deleted ${deleted}`);
      else toast.error(data.error ?? "Optimization failed");
    },
    onError: (e) => toast.error(e.message),
  });

  const [filter, setFilter] = useState(ALL);
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);

  const labels = useMemo(
    () => new Map<string, string>([["unified", "Unified"], ...(types ?? []).map((t) => [t.type, providerLabel(t.type, t.label)] as [string, string])]),
    [types],
  );
  const labelOf = (toolName: string) => labels.get(toolName) ?? toolName;

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of types ?? []) m.set(t.type, 0);
    for (const mem of memories ?? []) m.set(mem.toolName, (m.get(mem.toolName) ?? 0) + 1);
    return m;
  }, [memories, types]);

  const pool = (memories ?? []).filter((m) => filter === ALL || m.toolName === filter);
  const pages = Math.max(1, Math.ceil(pool.length / PAGE));
  const current = Math.min(page, pages - 1);
  const start = current * PAGE;
  const rows = pool.slice(start, start + PAGE);
  const optimizing = optimize.isPending;
  const canOptimize = filter !== ALL && pool.length > 0 && !optimizing;

  return (
    <Section title="Memory" description="Lessons the agents saved while querying. They read them before every question.">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          label="Filter memories by source"
          value={filter}
          onValueChange={(v) => {
            setFilter(v);
            setPage(0);
          }}
          options={[[ALL, memories?.length ?? 0] as const, ...counts].map(([key, n]) => ({
            value: key,
            label: (
              <>
                {key === ALL ? "All" : labelOf(key)} <span className="tabular-nums">{n}</span>
              </>
            ),
          }))}
          className="max-w-full overflow-x-auto"
        />
        <span className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            {/* aria-disabled keeps the button focusable so its tooltip can explain why. */}
            <Button
              variant="outline"
              size="sm"
              aria-disabled={!canOptimize}
              onClick={() => canOptimize && optimize.mutate({ toolName: filter })}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-background"
            >
              {optimizing ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {optimizing ? "Optimizing" : "Optimize"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{filter === ALL ? "Pick one source to optimize" : "Merge duplicates and drop stale lessons"}</TooltipContent>
        </Tooltip>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus />
          Add memory
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        {isLoading ? (
          <div className="space-y-3 px-4 py-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            No memories yet. The agent saves notes here as it learns from tool usage.
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map((m) => (
              <MemoryRow key={m.id} memory={m} label={labelOf(m.toolName)} />
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2 border-t px-4 py-2.5">
          <p className="flex-1 text-[13px]/[18px] text-muted-foreground tabular-nums">
            Showing {rows.length ? `${start + 1}–${start + rows.length}` : "0"} of {pool.length.toLocaleString()}
          </p>
          <Button variant="outline" size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            Next
          </Button>
        </div>
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent showCloseButton={false} className="sm:max-w-lg">
          {adding && (
            <AddMemoryForm
              initialProvider={filter === ALL ? "unified" : filter}
              options={[...labels]}
              onDone={() => setAdding(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function MemoryRow({ memory, label }: { memory: Memory; label: string }) {
  const utils = trpc.useUtils();
  const update = trpc.memory.update.useMutation({ onSuccess: () => utils.memory.list.invalidate() });
  const remove = trpc.memory.remove.useMutation({
    onSuccess: () => {
      utils.memory.list.invalidate();
      toast("Memory deleted");
    },
    onError: (e) => toast.error(e.message),
  });
  const [draft, setDraft] = useState<string | null>(null);

  if (draft !== null) {
    return (
      <li className="px-4 py-3">
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            try {
              await update.mutateAsync({ id: memory.id, note: draft.trim() });
              setDraft(null);
              toast.success("Memory updated");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Update failed");
            }
          }}
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Memory"
            className="min-h-20 bg-card text-sm"
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={!draft.trim() || update.isPending}>
              {update.isPending && <Loader2 className="animate-spin" />}
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={update.isPending} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="group/row flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm break-words">{memory.note}</p>
        {memory.reviewNote && <p className="mt-0.5 text-[13px]/[18px] text-muted-foreground italic">{memory.reviewNote}</p>}
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ProviderDot provider={memory.toolName} />
          {label} · {formatShortDate(memory.createdAt)}
        </p>
      </div>
      <div className="-my-0.5 flex shrink-0 gap-1 transition-opacity duration-150 group-focus-within/row:opacity-100 group-hover/row:opacity-100 [@media(hover:hover)]:opacity-0">
        <Button variant="ghost" size="xs" onClick={() => setDraft(memory.note)} aria-label={`Edit memory: ${memory.note}`}>
          Edit
        </Button>
        <ConfirmButton
          size="xs"
          trigger="Delete"
          triggerLabel={`Delete memory: ${memory.note}`}
          title="Delete this memory?"
          description="The agent will no longer read it before answering."
          action="Delete"
          disabled={remove.isPending}
          onConfirm={() => remove.mutate({ id: memory.id })}
        />
      </div>
    </li>
  );
}

function AddMemoryForm({ initialProvider, options, onDone }: { initialProvider: string; options: [string, string][]; onDone: () => void }) {
  const utils = trpc.useUtils();
  const create = trpc.memory.create.useMutation({
    onSuccess: () => {
      utils.memory.list.invalidate();
      toast.success("Memory added");
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });
  const [provider, setProvider] = useState(initialProvider);
  const [note, setNote] = useState("");

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (note.trim()) create.mutate({ toolName: provider, note: note.trim() });
      }}
    >
      <DialogHeader>
        <DialogTitle>Add memory</DialogTitle>
        <DialogDescription>Write one lesson in plain words. The agent reads it before every question.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="memory-source" className="text-[13px]/[18px]">
          Source
        </Label>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger id="memory-source" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {options.map(([value, label]) => (
              <SelectItem key={value} value={value}>
                <ProviderDot provider={value} />
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="memory-text" className="text-[13px]/[18px]">
          Note
        </Label>
        <Textarea
          id="memory-text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Reusable lesson or pattern"
          className="min-h-24"
          autoFocus
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={create.isPending} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!note.trim() || create.isPending}>
          {create.isPending && <Loader2 className="animate-spin" />}
          Add memory
        </Button>
      </DialogFooter>
    </form>
  );
}
