import type { ReactNode } from "react";
import { useState } from "react";
import { Spinner } from "../ui/Spinner";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { trpc } from "../../lib/trpc";
import { WEB_CONFIG } from "../../lib/config";
import { ProviderCard } from "./ProviderCard";
import { ProviderConfigModal } from "./ProviderConfigModal";
import { NoteBox, NOTE_LINK } from "./NoteBox";

type ConfigField = { key: string; label: string; type: string; required?: boolean };

/** Per-provider guidance shown in the config dialog: where to make the key and what it lets Tracer do. */
const PROVIDER_NOTES: Record<string, ReactNode> = {
  newrelic: (
    <NoteBox>
      <div>
        Create a <span className="font-medium">User key</span> at:
        <br />
        <a
          href="https://one.newrelic.com/admin-portal/api-keys/home"
          target="_blank"
          rel="noopener noreferrer"
          className={NOTE_LINK}
        >
          https://one.newrelic.com/admin-portal/api-keys/home
        </a>
        <br />
        Your numeric Account ID is shown on the same page.
      </div>
      <div>
        <div className="font-medium">What Tracer can do with it</div>
        <ul className="list-disc ml-4 mt-1 space-y-0.5">
          <li>
            <span className="font-medium">Run read-only NRQL queries</span> against your account —
            to inspect metrics, logs, traces, and errors while investigating.
          </li>
        </ul>
      </div>
      <div className="opacity-80">
        It only reads via NRQL. It cannot write, modify, deploy, or delete anything. A New Relic
        User key inherits your role, so for least privilege use a user scoped to read-only access.
      </div>
    </NoteBox>
  ),
  posthog: (
    <NoteBox>
      <div>
        Create a <span className="font-medium">Personal API key</span> in your PostHog instance at:
        <br />
        <span className="font-mono">/settings/user-api-keys</span>
        <br />
        Grant it the single scope <span className="font-medium">Query → Read</span>. The Project ID
        is in Settings → Project. Set Host only if you are not on US cloud (e.g.
        <span className="font-mono"> eu.posthog.com</span> or a self-hosted URL).
      </div>
      <div>
        <div className="font-medium">What Tracer can do with it</div>
        <ul className="list-disc ml-4 mt-1 space-y-0.5">
          <li>
            <span className="font-medium">Run read-only HogQL queries</span> against the project —
            to inspect events, persons, and analytics while investigating.
          </li>
        </ul>
      </div>
      <div className="opacity-80">
        With only the <span className="font-medium">Query → Read</span> scope it cannot create,
        modify, or delete anything in PostHog, and it reaches only the project you configure.
      </div>
    </NoteBox>
  ),
};

function buildInitialValues(fields: ConfigField[], existingConfig?: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    values[field.key] = existingConfig?.[field.key] ?? "";
  }
  return values;
}

export function DataProvidersSection() {
  const utils = trpc.useUtils();
  const { data: statuses, isLoading: statusLoading } = trpc.provider.list.useQuery();
  const { data: configs, isLoading: configsLoading } = trpc.provider.getConfigs.useQuery();
  const { data: registeredTypes, isLoading: typesLoading } = trpc.provider.getRegisteredTypes.useQuery();
  const { data: pingResults } = trpc.provider.ping.useQuery(undefined, {
    staleTime: WEB_CONFIG.sessionStaleTimeMs,
    refetchOnMount: "always",
  });

  const saveConfig = trpc.provider.saveConfig.useMutation({
    onSuccess: () => {
      utils.provider.list.invalidate();
      utils.provider.getConfigs.invalidate();
      utils.provider.ping.invalidate();
    },
  });
  const removeConfig = trpc.provider.removeConfig.useMutation({
    onSuccess: () => {
      utils.provider.list.invalidate();
      utils.provider.getConfigs.invalidate();
      utils.provider.ping.invalidate();
    },
  });

  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saveResult, setSaveResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [confirmRemoveProvider, setConfirmRemoveProvider] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<Record<string, string>>({});

  function handleEdit(type: string) {
    const config = configs?.find((c) => c.type === type);
    const meta = registeredTypes?.find((t) => t.type === type);

    setFormValues(buildInitialValues(meta?.configFields ?? [], config?.config));
    setSaveResult(null);
    setEditingProvider(type);
  }

  function handleClose() {
    setEditingProvider(null);
    setFormValues({});
    setSaveResult(null);
  }

  async function handleSave(type: string) {
    setSaveResult(null);
    try {
      const result = await saveConfig.mutateAsync({ type, config: formValues });
      setSaveResult(result);
      if (result.success) {
        setEditingProvider(null);
        setFormValues({});
      }
    } catch {
      setSaveResult({ success: false, error: "Failed to save configuration" });
    }
  }

  async function handleToggle(type: string, enabled: boolean) {
    if (enabled) {
      setToggleError((prev) => { const next = { ...prev }; delete next[type]; return next; });
      try {
        const result = await saveConfig.mutateAsync({ type, config: {} });
        if (!result.success) {
          setToggleError((prev) => ({ ...prev, [type]: result.error ?? "Connection failed" }));
        }
      } catch {
        setToggleError((prev) => ({ ...prev, [type]: "Failed to save configuration" }));
      }
    } else {
      setConfirmRemoveProvider(type);
    }
  }

  async function handleRemove(type: string) {
    await removeConfig.mutateAsync(type);
    setEditingProvider(null);
    setFormValues({});
    setSaveResult(null);
    setConfirmRemoveProvider(null);
  }

  const isLoading = statusLoading || configsLoading || typesLoading;
  const providerTypes = registeredTypes ?? [];

  if (isLoading) return <Spinner size="lg" centered />;

  const editingMeta = editingProvider ? providerTypes.find((t) => t.type === editingProvider) : null;
  const editingConfig = editingProvider ? configs?.find((c) => c.type === editingProvider) : null;

  return (
    <>
      <div className="flex flex-wrap gap-3">
        {providerTypes.map(({ type, label, configFields }) => {
          const status = statuses?.find((s) => s.type === type);
          const config = configs?.find((c) => c.type === type);
          const configured = !!config;
          const ping = pingResults?.find((p) => p.type === type);
          const connected = ping ? ping.ok : !!status?.connected;
          const hasConfigFields = configFields.length > 0;

          const pingError = ping && !ping.ok ? ping.error : undefined;

          return (
            <ProviderCard
              key={type}
              type={type}
              label={label}
              connected={connected}
              configured={configured}
              onConfigure={() => handleEdit(type)}
              onToggle={(enabled) => handleToggle(type, enabled)}
              togglePending={saveConfig.isPending || removeConfig.isPending}
              toggleError={toggleError[type]}
              pingError={pingError}
              hasConfigFields={hasConfigFields}
              existingConfig={config?.config}
            />
          );
        })}
      </div>

      {editingProvider && editingMeta && (
        <ProviderConfigModal
          open={true}
          label={editingMeta.label}
          configFields={editingMeta.configFields}
          formValues={formValues}
          onFormChange={(key, value) => setFormValues((prev) => ({ ...prev, [key]: value }))}
          existingConfig={editingConfig?.config ?? null}
          saveResult={saveResult}
          savePending={saveConfig.isPending}
          configured={!!editingConfig}
          note={PROVIDER_NOTES[editingProvider]}
          onSave={() => handleSave(editingProvider)}
          onClose={handleClose}
          onRemove={() => setConfirmRemoveProvider(editingProvider)}
        />
      )}

      <ConfirmDialog
        open={confirmRemoveProvider !== null}
        title="Disable provider"
        message={`Disable ${providerTypes.find((t) => t.type === confirmRemoveProvider)?.label ?? confirmRemoveProvider}?`}
        confirmLabel="Disable"
        onConfirm={() => { if (confirmRemoveProvider) handleRemove(confirmRemoveProvider); }}
        onCancel={() => setConfirmRemoveProvider(null)}
      />
    </>
  );
}
