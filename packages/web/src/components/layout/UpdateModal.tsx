import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { serverFetch } from "../../lib/server-fetch";

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll the (restarting) server until it answers, then reload to pick up the new build. */
async function waitForServerThenReload() {
  await delay(WEB_CONFIG.updateRestartProbeDelayMs);
  const deadline = Date.now() + WEB_CONFIG.updateRestartMaxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await serverFetch("/api/trpc/update.check", { cache: "no-store" });
      if (res.ok) break;
    } catch { /* server still down */ }
    await delay(WEB_CONFIG.updateRestartPollMs);
  }
  window.location.reload();
}

function CommandBlock({ command }: { command: string }) {
  return <code className="block rounded-md border bg-muted px-3 py-2 font-mono text-xs text-foreground select-all">{command}</code>;
}

export function UpdateModal({ open, onClose }: UpdateModalProps) {
  const updateCheck = trpc.update.check.useQuery(undefined, {
    staleTime: WEB_CONFIG.updateCheckStaleTimeMs,
  });
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = updateCheck.data;
  const canSelfUpdate = data?.canSelfUpdate === true;
  // npx re-runs an ephemeral copy, a source checkout pulls and rebuilds; `npm update -g` won't reliably cross versions.
  const manualCommand =
    data?.method === "npx"
      ? "npx tracer-sh@latest"
      : data?.method === "dev"
        ? "git pull && pnpm install && pnpm build"
        : "npm install -g tracer-sh@latest";

  const perform = trpc.update.perform.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        // The launcher restarts the server; reload once it answers to pick up the new UI build.
        setRestarting(true);
        void waitForServerThenReload();
      } else {
        setError(res.error ?? "Update failed.");
      }
    },
    onError: (err) => setError(err.message),
  });

  const updating = perform.isPending || restarting;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !updating && onClose()}>
      <DialogContent showCloseButton={!updating}>
        <DialogHeader>
          <DialogTitle>Update available</DialogTitle>
          <DialogDescription>
            Tracer <span className="font-mono text-foreground">{data?.latestVersion}</span> is out. You have{" "}
            <span className="font-mono text-foreground">{data?.currentVersion}</span>.
          </DialogDescription>
        </DialogHeader>

        {restarting ? (
          <p role="status" className="flex items-center gap-2 text-sm text-ink-2">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
            Installed. Restarting Tracer. This page reloads on its own.
          </p>
        ) : canSelfUpdate ? (
          error && (
            <div role="alert" className="space-y-2 text-sm">
              <p className="text-destructive">Update failed: {error}</p>
              <p className="text-muted-foreground">You can update manually instead:</p>
              <CommandBlock command={manualCommand} />
            </div>
          )
        ) : (
          <div className="space-y-2 text-sm">
            <p className="text-muted-foreground">This instance runs from a source checkout. Update it with:</p>
            <CommandBlock command={manualCommand} />
          </div>
        )}

        {!restarting && (
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={updating}>
              Close
            </Button>
            {canSelfUpdate && (
              <Button onClick={() => { setError(null); perform.mutate(); }} disabled={updating}>
                {updating && <Loader2 className="animate-spin" aria-hidden="true" />}
                {updating ? "Updating" : "Update now"}
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
