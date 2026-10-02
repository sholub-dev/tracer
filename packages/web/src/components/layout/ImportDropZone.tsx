import { useCallback, useRef } from "react";
import { ImageUp } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_SESSION_TITLE, ImportedAnalysisSchema, SESSION_KIND } from "@tracer-sh/shared";
import { cn } from "@/lib/utils";
import { useFileDrop } from "../../lib/hooks";
import { trpc } from "../../lib/trpc";
import { decodePngPayload } from "../../lib/png-steg";

export function ImportDropZone({ onImported }: { onImported: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const importMutation = trpc.sessions.importAnalysis.useMutation();

  const importPng = useCallback(async (file: File) => {
    const fail = (message: string) => toast.error(message);
    if (file.type !== "image/png") return fail("Only PNG files are supported.");
    if (file.size > 10 * 1024 * 1024) return fail("PNG is too large (>10 MB).");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let payload: Uint8Array | null;
      try { payload = await decodePngPayload(bytes); }
      catch { return fail("Not a valid PNG file."); }
      if (!payload) return fail("No analysis data found in this image.");
      let parsed;
      try { parsed = ImportedAnalysisSchema.parse(JSON.parse(new TextDecoder().decode(payload))); }
      catch { return fail("Analysis data is malformed or from an incompatible version."); }
      const { id } = await importMutation.mutateAsync(parsed);
      utils.sessions.list.setData(undefined, (prev) => {
        const row = {
          id,
          title: parsed.sourceTitle.slice(0, 80) || DEFAULT_SESSION_TITLE,
          status: "idle" as const,
          kind: SESSION_KIND.IMPORTED as string | null,
          updatedAt: Math.floor(Date.now() / 1000),
          titlePending: false,
        };
        return prev ? [row, ...prev] : [row];
      });
      onImported(id);
    } catch { fail("Couldn't import analysis."); }
  }, [importMutation, utils, onImported]);

  const onFiles = useCallback((files: FileList) => {
    if (files.length > 1) { toast.error("Drop a single PNG to import."); return; }
    importPng(files[0]);
  }, [importPng]);
  const { dragActive, dropProps } = useFileDrop(onFiles);

  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={importMutation.isPending}
        className={cn(
          "flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-input px-3 py-4 text-center transition-colors outline-none hover:border-ring/60 hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60",
          dragActive && "border-ring bg-sidebar-accent",
        )}
        {...dropProps}
      >
        <ImageUp className="mb-1 size-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-[13px]/[18px] font-medium">Import an analysis</span>
        <span className="text-xs text-muted-foreground">Drop a PNG from Download as image</span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) importPng(f); e.target.value = ""; }}
      />
    </>
  );
}
