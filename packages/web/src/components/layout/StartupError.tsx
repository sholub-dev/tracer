import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LocalDataError, resetLocalData } from "@/lib/ios-runtime";

/** Full-screen state when the iOS app cannot start; a database it cannot open can be reset. */
export function StartupError({ error }: { error: unknown }) {
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const message = error instanceof Error ? error.message : String(error);

  async function reset() {
    setResetting(true);
    try {
      await resetLocalData();
      window.location.reload();
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err));
      setResetting(false);
    }
  }

  return (
    <div role="alert" className="flex h-svh flex-col items-center justify-center gap-4 px-6 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-center">
      <h1 className="text-lg font-semibold">Tracer cannot start</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      {error instanceof LocalDataError && (confirming ? (
        <div className="flex max-w-sm flex-col items-center gap-3">
          <p className="text-sm">This deletes all sessions, monitors, settings and keys on this device. It cannot be undone.</p>
          <div className="flex gap-2">
            <Button variant="outline" disabled={resetting} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" disabled={resetting} onClick={reset}>Delete local data</Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setConfirming(true)}>Reset local data</Button>
      ))}
      {resetError && <p className="max-w-sm text-sm text-destructive">Reset failed: {resetError}</p>}
    </div>
  );
}
