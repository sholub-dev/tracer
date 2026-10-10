import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { setCopyLink, useCopyLink } from "../../lib/copy-link";
import { isSyncOver, modeText } from "../../lib/sync-steps";
import { trpc } from "../../lib/trpc";
import { SyncProgress } from "./SyncProgress";

export function CopyFromComputerDialog() {
  const link = useCopyLink();
  const utils = trpc.useUtils();
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const receive = trpc.transfer.receive.useMutation({
    onSuccess: (session) => {
      utils.transfer.receiveStatus.setData(undefined, session);
      setStarted(true);
    },
    onError: (e) => setError(e.message),
  });
  const cancel = trpc.transfer.cancelReceive.useMutation();
  const inspect = trpc.transfer.inspect.useQuery({ link: link ?? "" }, { enabled: !!link && !started, retry: false });
  const { data: status } = trpc.transfer.receiveStatus.useQuery(undefined, {
    enabled: started,
    refetchInterval: (q) => (q.state.data && isSyncOver(q.state.data.phase) ? false : 700),
  });
  const { mode, name, address } = inspect.data ?? { mode: null, name: "", address: "" };
  const computer = name || address || "your computer";

  const session = started ? status : null;
  const over = !!session && isSyncOver(session.phase);
  const running = !!session && !over;

  useEffect(() => {
    // The last sync time shows on the settings page behind the dialog.
    if (over) void utils.transfer.lastSync.invalidate();
  }, [over, utils]);

  const close = () => {
    setError(null);
    setStarted(false);
    setCopyLink(null);
  };

  return (
    <AlertDialog open={!!link} onOpenChange={(open) => !open && !running && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {!session ? `Sync with ${computer}?` : session.phase === "done" ? "Synced" : over ? "Sync stopped" : `Syncing with ${session.computerName || computer}`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            {session ? (
              <div className="sr-only">Steps of the sync with the computer.</div>
            ) : (
              <div className="space-y-2">
                <p>{mode ? modeText(mode, "phone") : "Checking the code."}</p>
                {mode === "replace" && <p>This replaces all data on this phone: sessions, monitors, data sources and keys. Monitors arrive paused. Sync only with your own computer.</p>}
                <p>Keep Tracer open until the sync ends.</p>
              </div>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {session && <SyncProgress session={session} device="phone" />}
        {!session && (error ?? inspect.error?.message) && <p role="alert" className="text-sm text-destructive">{error ?? inspect.error?.message}</p>}
        <AlertDialogFooter>
          {!session ? (
            <>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button
                variant={mode === "replace" ? "destructive" : "default"}
                disabled={receive.isPending || !mode}
                onClick={() => {
                  if (!link) return;
                  setError(null);
                  receive.mutate({ link });
                }}
              >
                {receive.isPending && <Loader2 className="animate-spin" />}
                Sync
              </Button>
            </>
          ) : session.phase === "done" ? (
            // The data changed under the open screens: a reload shows it.
            <Button onClick={() => window.location.reload()}>Done</Button>
          ) : over ? (
            <Button onClick={close}>Close</Button>
          ) : session.phase !== "apply" ? (
            <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Cancel sync</Button>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
