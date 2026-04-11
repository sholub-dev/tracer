import { useEffect, useRef, useState } from "react";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { Modal } from "../ui/Modal";

interface UpdateModalProps {
  open: boolean;
  onClose: () => void;
}

export function UpdateModal({ open, onClose }: UpdateModalProps) {
  const updateCheck = trpc.update.check.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
  });
  const [updating, setUpdating] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Clean up restart-poll interval on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const updateApply = trpc.update.install.useMutation({
    onMutate: () => setUpdating(true),
    onSettled: () => {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch("/api/trpc/update.check");
          if (res.ok) {
            clearInterval(pollRef.current!);
            pollRef.current = undefined;
            window.location.reload();
          }
        } catch { /* server still restarting */ }
      }, 1000);
    },
  });

  return (
    <Modal open={open} onClose={() => !updating && onClose()}>
      {updating ? (
        <>
          <div className={theme.dialogTitle}>Updating...</div>
          <div className="text-sm text-[#666666] mb-4 space-y-2">
            <p>Downloading and installing v{updateCheck.data?.latestVersion}.</p>
            <p>The server will restart automatically.</p>
          </div>
          <div className="flex justify-center">
            <span className={`inline-block w-5 h-5 border-2 rounded-full animate-spin ${theme.spinner}`} />
          </div>
        </>
      ) : (
        <>
          <div className={theme.dialogTitle}>Update Available</div>
          <div className="text-sm text-[#666666] mb-4 space-y-1">
            <p>
              Current version: <span className="font-mono">{updateCheck.data?.currentVersion}</span>
            </p>
            <p>
              Latest version: <span className="font-mono">{updateCheck.data?.latestVersion}</span>
            </p>
          </div>
          {updateApply.isError && (
            <p className={`${theme.errorText} mb-3`}>
              Update failed. Please try again.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={theme.secondaryBtn}>
              Close
            </button>
            <button
              onClick={() => updateApply.mutate()}
              className={theme.primaryBtn}
            >
              Update Now
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
