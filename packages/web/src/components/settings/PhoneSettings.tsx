import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { IS_IOS } from "../../lib/platform";
import { isSyncOver, megabytes, STEPS } from "../../lib/sync-steps";
import { trpc } from "../../lib/trpc";
import { Group, Row, Section } from "./parts";
import { SyncProgress } from "./SyncProgress";

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relativeTime(at: number): string {
  const seconds = Math.round((at - Date.now()) / 1000);
  for (const [unit, size] of [["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function LastSyncRow() {
  const { data } = trpc.transfer.lastSync.useQuery();
  if (!data) return null;
  return <Row label="Last synced" description={`Last synced with ${data.name || "another device"}, ${relativeTime(data.at)}.`} />;
}

const HOW_TO = [
  "On your computer, open Settings > Phone and click Show QR code. Then scan it with the iPhone Camera app.",
  "Go back to your computer and click Allow.",
  "The data moves to this phone. Keep Tracer open.",
  "This phone saves the data. Then tap Done.",
];

function IosPhoneSettings() {
  return (
    <Section title="Phone" description="Sync Tracer on this phone with Tracer on your computer. Both must use the same Wi-Fi. The first sync replaces the data on this phone with a copy of the computer's data. Later syncs keep the newest version of each item. Monitors from the computer arrive paused.">
      <Group>
        <LastSyncRow />
        <Row
          label="How to sync"
          description={
            <ol className="mt-1 space-y-1">
              {STEPS.map((step, i) => (
                <li key={step}>
                  {i + 1}. <span className="font-medium text-foreground">{step}.</span> {HOW_TO[i]}
                </li>
              ))}
            </ol>
          }
        />
      </Group>
    </Section>
  );
}

function DesktopPhoneSettings() {
  const utils = trpc.useUtils();
  const send = trpc.transfer.send.useMutation({
    // The last poll may still show the previous code.
    onSuccess: ({ session }) => utils.transfer.sendStatus.setData(undefined, session),
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
    refetchInterval: (q) => (q.state.data && isSyncOver(q.state.data.phase) ? false : 1000),
  });

  const session = status ?? code?.session;
  const phase = session?.phase;
  const over = !!phase && isSyncOver(phase);

  const shown = useRef(false);
  // Once the phone saves the data, the sync runs to its end, as it does on the phone.
  shown.current = !!code && phase !== "apply";
  const cancelOnUnmount = useRef(cancel.mutate);
  useEffect(() => () => {
    if (shown.current) cancelOnUnmount.current();
  }, []);

  useEffect(() => {
    // The phone changed this computer's data and the last sync time: lists must reload.
    if (over) void utils.invalidate();
  }, [over, utils]);
  const showNew = () => send.mutate();

  return (
    <Section title="Phone" description="Sync your monitors, settings, keys, memory and sessions with the Tracer app on your iPhone. The phone and this computer must use the same Wi-Fi. The first sync copies everything to the phone. Every later sync uses the same steps and keeps the newest version of each item.">
      <Group>
        <LastSyncRow />
        {!code || !session ? (
          <Row
            label="Sync with iPhone"
            description="Show a code, scan it with the iPhone Camera app, then click Allow here. The code works once, for 2 minutes."
            control={
              <Button onClick={showNew} disabled={send.isPending}>
                {send.isPending && <Loader2 className="animate-spin" />}
                Show QR code
              </Button>
            }
          />
        ) : (
          <div className="flex flex-wrap items-start gap-6 px-4 py-4">
            {phase === "waiting" && (
              <img
                alt="QR code to sync your data with the iPhone"
                src={"data:image/svg+xml;utf8," + encodeURIComponent(code.qrSvg)}
                className="size-56 rounded-lg bg-white p-3"
              />
            )}
            <SyncProgress session={session} device="computer">
              {phase === "waiting" && (
                <div className="space-y-2 text-[13px]/[18px] text-muted-foreground">
                  <p>Connect the phone to the same Wi-Fi as this computer.</p>
                  {code.fullCopy.fits ? (
                    <p>A first sync sends about {megabytes(code.fullCopy.bytes)}. Later syncs send only the changes.</p>
                  ) : (
                    <p role="alert" className="text-destructive">
                      A first sync with a new phone will likely fail. The full copy is about {megabytes(code.fullCopy.bytes)} and the limit is {megabytes(code.fullCopy.limitBytes)}. Delete sessions you do not need. A phone that synced before can still sync the changes.
                    </p>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                {phase === "approval" && (
                  <>
                    <Button onClick={() => approve.mutate()} disabled={approve.isPending}>Allow</Button>
                    <Button variant="outline" onClick={() => deny.mutate()} disabled={deny.isPending}>Deny</Button>
                  </>
                )}
                {over && (
                  <Button onClick={showNew} disabled={send.isPending}>
                    {send.isPending && <Loader2 className="animate-spin" />}
                    {phase === "done" ? "Sync again" : "Show a new code"}
                  </Button>
                )}
                {phase !== "approval" && phase !== "apply" && (
                  <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                    {over ? "Close" : "Cancel"}
                  </Button>
                )}
              </div>
            </SyncProgress>
          </div>
        )}
      </Group>
    </Section>
  );
}

export function PhoneSettings() {
  return IS_IOS ? <IosPhoneSettings /> : <DesktopPhoneSettings />;
}
