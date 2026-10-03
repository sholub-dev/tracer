import { useState } from "react";
import { Loader2 } from "lucide-react";

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
import { setCopyLink, useCopyLink } from "../../lib/copy-link";
import { trpc } from "../../lib/trpc";

export function CopyFromComputerDialog() {
  const link = useCopyLink();
  const [error, setError] = useState<string | null>(null);
  const receive = trpc.transfer.receive.useMutation({
    onSuccess: () => window.location.reload(),
    onError: (e) => setError(e.message),
  });
  const inspect = trpc.transfer.inspect.useQuery({ link: link ?? "" }, { enabled: !!link, retry: false });
  const { mode, name, address } = inspect.data ?? { mode: null, name: "", address: "" };
  const computer = [name, address].filter(Boolean).join(" · ");

  const close = () => {
    setError(null);
    setCopyLink(null);
  };

  return (
    <AlertDialog open={!!link} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{mode === "merge" ? "Sync with your computer?" : "Copy data from your computer?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {receive.isPending ? (
              <>Waiting for approval on {name || address || "the computer"}.</>
            ) : mode === "merge" ? (
              <>Sync with {computer}. Both devices keep the newest version of each item. Deletions carry over.</>
            ) : (
              <>
                {computer ? <>Computer: {computer}. </> : null}
                This replaces all data on this phone: sessions, monitors, data sources and keys. Copy only from your own computer.
                Monitors arrive paused.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {(error ?? inspect.error?.message) && <p role="alert" className="text-sm text-destructive">{error ?? inspect.error?.message}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={mode === "merge" ? "default" : "destructive"}
            disabled={receive.isPending || !mode}
            onClick={(e) => {
              e.preventDefault();
              if (!link) return;
              setError(null);
              receive.mutate({ link });
            }}
          >
            {receive.isPending && <Loader2 className="animate-spin" />}
            {mode === "merge" ? "Sync" : "Replace"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
