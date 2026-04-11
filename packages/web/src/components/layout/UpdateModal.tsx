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

  return (
    <Modal open={open} onClose={onClose}>
      <div className={theme.dialogTitle}>Update Available</div>
      <div className="text-sm text-[#666666] mb-4 space-y-1">
        <p>
          Current version: <span className="font-mono">{updateCheck.data?.currentVersion}</span>
        </p>
        <p>
          Latest version: <span className="font-mono">{updateCheck.data?.latestVersion}</span>
        </p>
      </div>
      <div className="text-sm text-[#666666] mb-4">
        <p>Run this command to update:</p>
        <code className="block mt-2 p-2 bg-[#1a1a1a] rounded font-mono text-xs text-[#e0e0e0]">
          npm update -g oko-sh
        </code>
      </div>
      <div className="flex justify-end">
        <button onClick={onClose} className={theme.secondaryBtn}>
          Close
        </button>
      </div>
    </Modal>
  );
}
