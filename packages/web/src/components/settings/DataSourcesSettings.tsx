import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "../../lib/trpc";
import { useGcpAuthStatus } from "../../lib/hooks";
import { ConnectionRow, Group, Section } from "./parts";
import { PROVIDER_NOTES } from "./notes";
import { GcloudHint, GcpProjectField } from "./GcpProjectField";

const DETAIL: Record<string, (c: Record<string, string>) => string> = {
  newrelic: (c) => (c.accountId ? `Account ${c.accountId} · NRQL` : "NRQL queries"),
  posthog: (c) => (c.projectId ? `Project ${c.projectId} · HogQL` : "HogQL queries"),
  gcp: (c) => (c.projectId ? `${c.projectId} · Logging and Monitoring` : "Logging and Monitoring"),
};

export function DataSourcesSettings() {
  const utils = trpc.useUtils();
  const { data: statuses, isLoading: statusLoading } = trpc.provider.list.useQuery();
  const { data: configs, isLoading: configsLoading } = trpc.provider.getConfigs.useQuery();
  const { data: types, isLoading: typesLoading } = trpc.provider.getRegisteredTypes.useQuery();
  const { data: pings } = trpc.provider.ping.useQuery(undefined, { refetchOnMount: "always" });
  const auth = useGcpAuthStatus();

  const invalidate = () => {
    utils.provider.list.invalidate();
    utils.provider.getConfigs.invalidate();
    utils.provider.ping.invalidate();
  };
  const saveConfig = trpc.provider.saveConfig.useMutation({ onSuccess: invalidate });
  const removeConfig = trpc.provider.removeConfig.useMutation({ onSuccess: invalidate });
  const pending = saveConfig.isPending || removeConfig.isPending;

  return (
    <Section title="Data sources" description="Where the agent runs its queries. Each source gets its own agent and memory.">
      <Group>
        {statusLoading || configsLoading || typesLoading
          ? [0, 1, 2].map((i) => (
              <div key={i} className="flex min-h-14 items-center gap-4 px-4 py-3">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="ml-auto h-8 w-24" />
              </div>
            ))
          : (types ?? []).map(({ type, label, configFields }) => {
              const config = configs?.find((c) => c.type === type)?.config;
              const ping = pings?.find((p) => p.type === type);
              const connected = ping ? ping.ok : !!statuses?.find((s) => s.type === type)?.connected;
              const configured = !!config;
              const pingError = ping && !ping.ok ? ping.error : undefined;
              const isGcp = type === "gcp";

              return (
                <ConnectionRow
                  key={type}
                  name={label}
                  provider={type}
                  detail={DETAIL[type]?.(config ?? {})}
                  tone={connected ? "ok" : configured ? "warn" : "off"}
                  status={connected ? "Connected" : configured ? "Connection failed" : "Not connected"}
                  warning={configured && !connected ? pingError : undefined}
                  connected={configured || connected}
                  fields={configFields}
                  existingConfig={config ?? null}
                  note={PROVIDER_NOTES[type]}
                  pending={pending}
                  onSave={configFields.length ? (values) => saveConfig.mutateAsync({ type, config: values }) : undefined}
                  onConnect={configFields.length ? undefined : () => saveConfig.mutateAsync({ type, config: {} })}
                  remove={{
                    label: "Disconnect",
                    title: `Disconnect ${label}?`,
                    description: "The agent stops querying it. Monitors that use it pause.",
                    onConfirm: () => removeConfig.mutateAsync(type),
                  }}
                  extra={
                    isGcp &&
                    (auth.data && !auth.data.ok ? (
                      <GcloudHint message={auth.data.message} />
                    ) : (
                      <div className="sm:w-1/2 sm:pr-2">
                        <GcpProjectField
                          value={config?.projectId ?? ""}
                          disabled={pending}
                          onChange={(projectId) => saveConfig.mutate({ type: "gcp", config: { ...config, projectId } })}
                        />
                      </div>
                    ))
                  }
                />
              );
            })}
      </Group>
    </Section>
  );
}
