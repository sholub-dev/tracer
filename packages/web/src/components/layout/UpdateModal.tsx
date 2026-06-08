import { useState } from "react";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { Modal } from "../ui/Modal";

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
      const res = await fetch("/api/trpc/update.check", { cache: "no-store" });
      if (res.ok) break;
    } catch { /* server still down — keep polling */ }
    await delay(WEB_CONFIG.updateRestartPollMs);
  }
  window.location.reload();
}

function CommandBlock({ command }: { command: string }) {
  return (
    <code className="block mt-2 p-2 bg-[#1a1a1a] rounded font-mono text-xs text-[#e0e0e0]">
      {command}
    </code>
  );
}

export function UpdateModal({ open, onClose }: UpdateModalProps) {
  const updateCheck = trpc.update.check.useQuery(undefined, {
    staleTime: WEB_CONFIG.updateCheckStaleTimeMs,
  });
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = updateCheck.data;
  const canSelfUpdate = data?.canSelfUpdate === true;
  // Match the command the server actually runs; `npm update -g` won't reliably
  // upgrade a global package across versions.
  const manualCommand = data?.method === "npx" ? "npx tracer-sh@latest" : "npm install -g tracer-sh@latest";

  const perform = trpc.update.perform.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        // The server installs the new version and restarts; the launcher brings
        // it back up. Wait for it to answer again, then reload the new UI build.
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
    <Modal open={open} onClose={updating ? () => {} : onClose}>
      <div className={theme.dialogTitle}>Update Available</div>
      <div className="text-sm text-[#666666] mb-4 space-y-1">
        <p>
          Current version: <span className="font-mono">{data?.currentVersion}</span>
        </p>
        <p>
          Latest version: <span className="font-mono">{data?.latestVersion}</span>
        </p>
      </div>

      {restarting ? (
        <div className="text-sm text-[#666666] mb-4">
          <p>Installed. Restarting Tracer — this page will reload automatically.</p>
        </div>
      ) : canSelfUpdate ? (
        <>
          {error && (
            <div className="text-sm text-[#b3261e] mb-4">
              <p>Update failed: {error}</p>
              <p className="mt-2 text-[#666666]">You can update manually instead:</p>
              <CommandBlock command={manualCommand} />
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className={theme.secondaryBtn} disabled={updating}>
              Close
            </button>
            <button onClick={() => { setError(null); perform.mutate(); }} className={theme.primaryBtn} disabled={updating}>
              {updating ? "Updating…" : "Update now"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="text-sm text-[#666666] mb-4">
            <p>
              {data?.method === "npx"
                ? "This instance runs via npx and can't update itself. Re-run:"
                : "Run this command to update:"}
            </p>
            <CommandBlock command={manualCommand} />
          </div>
          <div className="flex justify-end">
            <button onClick={onClose} className={theme.secondaryBtn}>
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
