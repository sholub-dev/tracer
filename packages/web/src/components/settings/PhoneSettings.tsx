import { useEffect, useRef } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { IS_IOS } from "../../lib/platform";
import { trpc } from "../../lib/trpc";
import { Group, Row, Section } from "./parts";

const FINAL_SEND_STATES = new Set(["sent", "denied", "expired", "failed"]);

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relativeTime(at: number): string {
  const seconds = Math.round((at - Date.now()) / 1000);
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function LastSyncRow() {
  const { data } = trpc.transfer.lastSync.useQuery();
  if (!data) return null;
  return <Row label="Last synced" description={`Last synced with ${data.name || "another device"}, ${relativeTime(data.at)}.`} />;
}

function IosPhoneSettings() {
  return (
    <Section title="Phone" description="Sync Tracer on your computer with this phone. The first sync copies everything and replaces the data on this phone. Later syncs keep the newest version of each item. Monitors from the computer arrive paused.">
      <Group>
        <LastSyncRow />
        <Row
          label="How to copy"
          description="On your computer, open Tracer > Settings > Phone and click Show QR code. Then scan the code with the iPhone Camera app."
        />
      </Group>
    </Section>
  );
}

function DesktopPhoneSettings() {
  const utils = trpc.useUtils();
  const send = trpc.transfer.send.useMutation({
    // The last poll may still say "sent" or "expired" from the previous code.
    onSuccess: () => utils.transfer.sendStatus.setData(undefined, { state: "waiting" }),
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.transfer.cancelSend.useMutation({
    onSuccess: () => send.reset(),
    onError: (e) => toast.error(e.message),
  });
  const approve = trpc.transfer.approve.useMutation({ onError: (e) => toast.error(e.message) });
  const deny = trpc.transfer.deny.useMutation({ onError: (e) => toast.error(e.message) });
  const code = send.data;
  const { data: status } = trpc.transfer.sendStatus.useQuery(undefined, {
    enabled: !!code,
    refetchInterval: (q) => (FINAL_SEND_STATES.has(q.state.data?.state ?? "") ? false : 1000),
  });

  const shown = useRef(false);
  shown.current = !!code;
  const cancelOnUnmount = useRef(cancel.mutate);
  useEffect(() => () => {
    if (shown.current) cancelOnUnmount.current();
  }, []);

  const state = status?.state ?? "waiting";
  const finished = state === "sent" || state === "expired" || state === "denied" || state === "failed";
  const waiting = state === "waiting" || state === "idle";

  useEffect(() => {
    // The phone changed this computer's data: lists must reload.
    if (state === "sent") void utils.invalidate();
  }, [state, utils]);
  const showNew = () => send.mutate();

  return (
    <Section title="Phone" description="Sync your monitors, settings, keys, memory and sessions with the Tracer app on your iPhone. The first sync copies everything. Later syncs keep the newest version of each item.">
      <Group>
        <LastSyncRow />
        {!code ? (
          <Row
            label="Sync with iPhone"
            description="The code works once, for 2 minutes."
            control={
              <Button onClick={showNew} disabled={send.isPending}>
                {send.isPending && <Loader2 className="animate-spin" />}
                Show QR code
              </Button>
            }
          />
        ) : (
          <div className="flex flex-wrap items-center gap-6 px-4 py-4">
            {waiting ? (
              <img
                alt="QR code to sync your data with the iPhone"
                src={"data:image/svg+xml;utf8," + encodeURIComponent(code.qrSvg)}
                className="size-56 rounded-lg bg-white p-3"
              />
            ) : (
              <div className="flex min-h-56 flex-1 basis-56 items-center">
                {state === "sent" ? (
                  <span role="status" className="flex items-start gap-1.5 text-sm text-success">
                    <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {status?.mode === "merge"
                      ? `Synced with ${status.phoneName}. ${status.applied ?? 0} items changed here, ${status.deleted ?? 0} removed. New monitors arrive paused.`
                      : `Synced with ${status?.phoneName}. The phone now imports the data.`}
                  </span>
                ) : state === "approval" ? (
                  <span role="status" className="text-sm">
                    {status?.phoneName} wants to {status?.mode === "merge" ? "sync with" : "replace its data with"} this computer.
                  </span>
                ) : state === "approved" ? (
                  <span role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    Syncing with {status?.phoneName}.
                  </span>
                ) : state === "failed" ? (
                  <span role="alert" className="text-sm text-destructive">
                    {status?.error ?? "The sync failed."}
                  </span>
                ) : (
                  <span role="status" className="text-sm text-muted-foreground">
                    {state === "denied" ? "You denied the request." : "The code expired."}
                  </span>
                )}
              </div>
            )}
            <div className="min-w-0 flex-1 basis-56 space-y-4">
              {waiting && (
                <>
                  <ol className="space-y-1 text-[13px]/[18px] text-ink-2">
                    <li>1. Connect the phone to the same Wi-Fi as this computer.</li>
                    <li>2. Open the iPhone Camera and point it at the code.</li>
                    <li>3. Tap the Tracer link, then confirm on the phone.</li>
                  </ol>
                  <p className="text-[13px]/[18px] text-muted-foreground">The code works once, for 2 minutes. You allow the sync on this computer after the phone asks.</p>
                  {code.fullCopy.fits ? (
                    <p className="text-[13px]/[18px] text-muted-foreground">A first sync sends about {megabytes(code.fullCopy.bytes)}. Later syncs send only the changes.</p>
                  ) : (
                    <p role="alert" className="text-[13px]/[18px] text-destructive">
                      A first sync with a new phone will likely fail. The full copy is about {megabytes(code.fullCopy.bytes)} and the limit is {megabytes(code.fullCopy.limitBytes)}. Delete sessions you do not need. A phone that synced before can still sync the changes.
                    </p>
                  )}
                </>
              )}
              <div className="flex gap-2">
                {state === "approval" && (
                  <>
                    <Button onClick={() => approve.mutate()} disabled={approve.isPending}>Allow</Button>
                    <Button variant="outline" onClick={() => deny.mutate()} disabled={deny.isPending}>Deny</Button>
                  </>
                )}
                {finished && (
                  <Button onClick={showNew} disabled={send.isPending}>
                    {send.isPending && <Loader2 className="animate-spin" />}
                    Show a new code
                  </Button>
                )}
                {state !== "approval" && (
                  <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                    {finished ? "Close" : "Cancel"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </Group>
    </Section>
  );
}

export function PhoneSettings() {
  return IS_IOS ? <IosPhoneSettings /> : <DesktopPhoneSettings />;
}
