import { useState, type ReactNode } from "react";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { Spinner } from "../ui/Spinner";
import { StatusIndicator } from "../ui/StatusIndicator";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ProviderConfigModal, type ConfigField, type SaveResult } from "./ProviderConfigModal";
import { NoteBox, NOTE_LINK } from "./NoteBox";

// Classic Atlassian API token (id.atlassian.com -> "Create API token"). It uses the
// account's Jira permissions; Tracer limits what it can do at the code/tool layer
// (read an issue, post a comment) rather than via token scopes.
const JIRA_FIELDS = [
  { key: "domain", label: "Domain (yourco → yourco.atlassian.net)", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "apiToken", label: "API Token", type: "password" },
];

const JIRA_NOTE = (
  <NoteBox>
    <div>
      Create a token (use the plain <span className="font-medium">Create API token</span>, not
      "with scopes") at:
      <br />
      <a
        href="https://id.atlassian.com/manage-profile/security/api-tokens"
        target="_blank"
        rel="noopener noreferrer"
        className={NOTE_LINK}
      >
        https://id.atlassian.com/manage-profile/security/api-tokens
      </a>
    </div>
    <div>
      <div className="font-medium">What Tracer can do with it</div>
      <ul className="list-disc ml-4 mt-1 space-y-0.5">
        <li>
          <span className="font-medium">Read an issue</span> — summary, description, status, type,
          priority, assignee, reporter, labels, components, fix versions, resolution, dates, and
          its comment thread
        </li>
        <li>
          <span className="font-medium">Post a comment</span> — plain text, only when you ask
        </li>
      </ul>
    </div>
    <div className="opacity-80">
      It cannot edit, transition, delete, bulk-read, or administer anything else. The token uses
      its account's permissions, so for least privilege point it at a Jira account limited to the
      projects Tracer should touch.
    </div>
  </NoteBox>
);

const SLACK_FIELDS = [
  { key: "webhookUrl", label: "Webhook URL", type: "password" },
  { key: "mentions", label: "Tag on every alert (member IDs, @here, @channel)", type: "text", required: false },
];

const SLACK_NOTE = (
  <NoteBox>
    <div>
      At{" "}
      <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className={NOTE_LINK}>
        https://api.slack.com/apps
      </a>
      : <span className="font-medium">Create New App</span> (from scratch), then{" "}
      <span className="font-medium">Incoming Webhooks</span>, turn it on,{" "}
      <span className="font-medium">Add New Webhook</span>, pick a channel and copy the URL.
    </div>
    <div className="opacity-80">
      Saving posts a test message. When a monitor fires and its debug session finishes, Tracer
      posts what it found: the severity and a one-line root cause of the issue, then the monitor
      that found it. Repeats and firings with Alert off are not posted. Everyone in the
      channel sees these findings, so pick a channel with the right access. Emails, phone
      numbers and long numbers are masked.
    </div>
    <div className="opacity-80">
      Tags need Slack member IDs, not names: open the profile, then More (...), then{" "}
      <span className="font-medium">Copy member ID</span> (e.g. U0123ABCD). Separate several with commas.
    </div>
  </NoteBox>
);

interface IntegrationCardProps {
  label: string;
  fields: ConfigField[];
  note: ReactNode;
  configured: boolean;
  existingConfig: Record<string, string> | null;
  pending: boolean;
  onSave: (values: Record<string, string>) => Promise<SaveResult>;
  onRemove: () => Promise<unknown>;
}

function IntegrationCard({ label, fields, note, configured, existingConfig, pending, onSave, onRemove }: IntegrationCardProps) {
  const [editing, setEditing] = useState(false);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  function openModal() {
    setFormValues(Object.fromEntries(fields.map((f) => [f.key, existingConfig?.[f.key] ?? ""])));
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
      const result = await onSave(formValues);
      setSaveResult(result);
      if (result.success) closeModal();
    } catch {
      setSaveResult({ success: false, error: "Failed to save configuration" });
    }
  }

  async function handleRemove() {
    await onRemove();
    setConfirmRemove(false);
    closeModal();
  }

  return (
    <>
      <div className={theme.settingsCard + " w-80"}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <ToggleSwitch
              checked={configured}
              onChange={(enabled) => {
                if (enabled) openModal();
                else setConfirmRemove(true);
              }}
              disabled={pending}
            />
            <span className="font-medium">{label}</span>
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

      {editing && (
        <ProviderConfigModal
          open={true}
          label={label}
          configFields={fields}
          formValues={formValues}
          onFormChange={(key, value) => setFormValues((prev) => ({ ...prev, [key]: value }))}
          existingConfig={existingConfig}
          saveResult={saveResult}
          savePending={pending}
          configured={configured}
          note={note}
          onSave={handleSave}
          onClose={closeModal}
          onRemove={() => setConfirmRemove(true)}
        />
      )}

      <ConfirmDialog
        open={confirmRemove}
        title={`Disable ${label}`}
        message={`Disable the ${label} integration?`}
        confirmLabel="Disable"
        onConfirm={handleRemove}
        onCancel={() => setConfirmRemove(false)}
      />
    </>
  );
}

export function IntegrationsSection() {
  const utils = trpc.useUtils();
  const jira = trpc.integrations.getJira.useQuery();
  const slack = trpc.integrations.getSlack.useQuery();
  const onJira = { onSuccess: () => utils.integrations.getJira.invalidate() };
  const onSlack = { onSuccess: () => utils.integrations.getSlack.invalidate() };
  const saveJira = trpc.integrations.saveJira.useMutation(onJira);
  const removeJira = trpc.integrations.removeJira.useMutation(onJira);
  const saveSlack = trpc.integrations.saveSlack.useMutation(onSlack);
  const removeSlack = trpc.integrations.removeSlack.useMutation(onSlack);

  if (jira.isLoading || slack.isLoading) return <Spinner size="lg" centered />;

  return (
    <div className="flex flex-wrap gap-3">
      <IntegrationCard
        label="Jira"
        fields={JIRA_FIELDS}
        note={JIRA_NOTE}
        configured={!!jira.data?.configured}
        existingConfig={jira.data?.config ?? null}
        pending={saveJira.isPending || removeJira.isPending}
        onSave={(v) => saveJira.mutateAsync({ domain: v.domain ?? "", email: v.email ?? "", apiToken: v.apiToken ?? "" })}
        onRemove={() => removeJira.mutateAsync()}
      />
      <IntegrationCard
        label="Slack"
        fields={SLACK_FIELDS}
        note={SLACK_NOTE}
        configured={!!slack.data?.configured}
        existingConfig={slack.data?.config ?? null}
        pending={saveSlack.isPending || removeSlack.isPending}
        onSave={(v) => saveSlack.mutateAsync({ webhookUrl: v.webhookUrl ?? "", mentions: v.mentions ?? "" })}
        onRemove={() => removeSlack.mutateAsync()}
      />
    </div>
  );
}
