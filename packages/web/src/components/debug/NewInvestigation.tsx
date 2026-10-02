import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { SESSION_KIND } from "@tracer-sh/shared";
import { trpc } from "../../lib/trpc";
import { formatTime } from "../../lib/monitor-utils";
import { providerLabel, sortProviders } from "../../lib/providers";
import { ProviderDot } from "../common/ProviderDot";
import { useConnectedProviders } from "../chat/SourcesToggle";

const STARTERS = 3;

function SourcesLine() {
  const connected = useConnectedProviders();
  const { data: registered } = trpc.provider.getRegisteredTypes.useQuery();
  if (!connected || !registered) return <div className="mt-3 h-[18px]" aria-hidden="true" />;
  const on = new Set(connected.map((p) => p.type));
  return (
    <ul className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[13px]/[18px] text-ink-2" aria-label="Data sources">
      {sortProviders(registered).map((p) =>
        on.has(p.type) ? (
          <li key={p.type} className="flex items-center gap-1.5">
            <ProviderDot provider={p.type} />
            {providerLabel(p.type, p.label)} connected
          </li>
        ) : (
          <li key={p.type} className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden="true" className="size-2 rounded-full border border-muted-foreground/60" />
            {providerLabel(p.type, p.label)} not connected
          </li>
        ),
      )}
    </ul>
  );
}

/** Starter prompts from the latest alert investigations. */
function RecentAlerts({ onPick }: { onPick: (text: string) => void }) {
  const { data } = trpc.sessions.list.useQuery();
  const seen = new Set<string>();
  const alerts = (data ?? [])
    .filter((s) => s.kind === SESSION_KIND.MONITOR && !s.titlePending && !seen.has(s.title) && seen.add(s.title))
    .slice(0, STARTERS);
  if (alerts.length === 0) return null;
  return (
    <section aria-labelledby="recent-alerts" className="mt-8 overflow-hidden rounded-lg border bg-card">
      <h2 id="recent-alerts" className="border-b px-4 py-2.5 text-xs font-medium text-muted-foreground">
        From recent alerts
      </h2>
      <ul className="divide-y">
        {alerts.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onPick(`Why did "${s.title}" fire, and is it still happening?`)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-150 outline-none hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">Why did {s.title} fire?</span>
                <span className="block truncate text-xs text-muted-foreground">Alert · {formatTime(s.updatedAt)}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NewInvestigation({ composer, onPick }: { composer: ReactNode; onPick: (text: string) => void }) {
  return (
    <div className="mx-auto w-full max-w-[712px] px-4 pt-[10vh] pb-16 sm:px-6 lg:pt-[14vh]">
      <h1 className="text-center text-2xl font-semibold tracking-tight text-balance">What are you investigating?</h1>
      <SourcesLine />
      <div className="mt-8">{composer}</div>
      <RecentAlerts onPick={onPick} />
      <p className="mt-6 text-center text-xs text-muted-foreground">Answers can be wrong. Check the queries before you share a finding.</p>
    </div>
  );
}
