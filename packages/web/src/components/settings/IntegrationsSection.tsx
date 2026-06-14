import { useState } from "react";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { Spinner } from "../ui/Spinner";
import { StatusIndicator } from "../ui/StatusIndicator";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ProviderConfigModal } from "./ProviderConfigModal";

const JIRA_FIELDS = [
  { key: "domain", label: "Domain (yourco → yourco.atlassian.net)", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "apiToken", label: "API Token", type: "password" },
];

export function IntegrationsSection() {
  const utils = trpc.useUtils();
  const { data: jira, isLoading } = trpc.integrations.getJira.useQuery();

  const saveJira = trpc.integrations.saveJira.useMutation({
    onSuccess: () => utils.integrations.getJira.invalidate(),
  });
  const removeJira = trpc.integrations.removeJira.useMutation({
    onSuccess: () => utils.integrations.getJira.invalidate(),
  });

  const [editing, setEditing] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saveResult, setSaveResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const configured = !!jira?.configured;
  const existingConfig = jira?.config ?? null;

  function openModal() {
    setFormValues({
      domain: existingConfig?.domain ?? "",
      email: existingConfig?.email ?? "",
      apiToken: existingConfig?.apiToken ?? "",
    });
    setSaveResult(null);
    setEditing(true);
  }

  function closeModal() {
    setEditing(false);
    setFormValues({});
    setSaveResult(null);
  }

  async function handleSave() {
    setSaveResult(null);
    try {
      const result = await saveJira.mutateAsync({
        domain: formValues.domain ?? "",
        email: formValues.email ?? "",
        apiToken: formValues.apiToken ?? "",
      });
      setSaveResult(result);
      if (result.success) closeModal();
    } catch {
      setSaveResult({ success: false, error: "Failed to save configuration" });
    }
  }

  async function handleRemove() {
    await removeJira.mutateAsync();
    setConfirmRemove(false);
    closeModal();
  }

  if (isLoading) return <Spinner size="lg" centered />;

  return (
    <>
      <div className="flex flex-wrap gap-3">
        <div className={theme.settingsCard + " w-80"}>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <ToggleSwitch
                checked={configured}
                onChange={(enabled) => {
                  if (enabled) openModal();
                  else setConfirmRemove(true);
                }}
                disabled={saveJira.isPending || removeJira.isPending}
              />
              <span className="font-medium">Jira</span>
              {configured ? (
                <StatusIndicator status="connected" />
              ) : (
                <span className="text-xs opacity-40">Not configured</span>
              )}
            </div>
            <button
              onClick={openModal}
              className={`${theme.secondaryBtn} ${configured ? "" : "invisible"}`}
            >
              Edit
            </button>
          </div>
        </div>
      </div>

      {editing && (
        <ProviderConfigModal
          open={true}
          label="Jira"
          configFields={JIRA_FIELDS}
          formValues={formValues}
          onFormChange={(key, value) => setFormValues((prev) => ({ ...prev, [key]: value }))}
          existingConfig={existingConfig}
          saveResult={saveResult}
          savePending={saveJira.isPending}
          configured={configured}
          onSave={handleSave}
          onClose={closeModal}
          onRemove={() => setConfirmRemove(true)}
        />
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="Disable Jira"
        message="Disable the Jira integration?"
        confirmLabel="Disable"
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
}
