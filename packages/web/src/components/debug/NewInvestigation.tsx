import type { ReactNode } from "react";
import { trpc } from "../../lib/trpc";
import { providerLabel, sortProviders } from "../../lib/providers";
import { ProviderDot } from "../common/ProviderDot";
import { useConnectedProviders } from "../chat/SourcesToggle";

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

export function NewInvestigation({ composer }: { composer: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-[712px] px-4 pt-[10vh] pb-16 sm:px-6 lg:pt-[14vh]">
      <h1 className="text-center text-2xl font-semibold tracking-tight text-balance">What are you investigating?</h1>
      <SourcesLine />
      <div className="mt-8">{composer}</div>
      <p className="mt-6 text-center text-xs text-muted-foreground">Answers can be wrong. Check the queries before you share a finding.</p>
    </div>
  );
}
