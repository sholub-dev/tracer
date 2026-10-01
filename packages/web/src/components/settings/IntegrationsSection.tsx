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
  children?: ReactNode;
}

function IntegrationCard({ label, fields, note, configured, existingConfig, pending, onSave, onRemove, children }: IntegrationCardProps) {
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
        {configured && children}
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

const TRIAGE_TIP = [
  "Off: monitors post their analysis to Slack as usual. Nothing changes in New Relic.",
  "On: Tracer acts on the New Relic issue behind each alert of monitors on NrAiIncident:",
  "- Stopped: acks, then closes it (JSM closes its alert). Pings you if severity is high.",
  "- Ongoing or recurring: no ack, no close, so JSM keeps escalating. Pings you; the agent sets its own follow-up timer and acks and closes it once it stops.",
  "- Status unknown or close failed: leaves it open, pings you.",
  "- Closed 3 times in 24h and it keeps coming back: stops closing, pings you.",
  "- Still ongoing after 24h: stops following up, pings you.",
].join("\n");

function AlertTriageRow() {
  const utils = trpc.useUtils();
  const { data: enabled } = trpc.settings.getAlertTriage.useQuery();
  const save = trpc.settings.setAlertTriage.useMutation({ onSettled: () => utils.settings.getAlertTriage.invalidate() });
  if (enabled === undefined) return null;
  return (
    <div className="mt-3 pt-3 border-t border-[#e8e6e1]" title={TRIAGE_TIP}>
      <div className="flex items-center gap-2">
        <ToggleSwitch
          checked={enabled}
          disabled={save.isPending}
          aria-label="Alert triage"
          onChange={(v) => {
            utils.settings.getAlertTriage.setData(undefined, v);
            save.mutate({ enabled: v });
          }}
        />
        <span className="font-medium">Alert triage</span>
      </div>
      <div className="text-xs opacity-40 mt-1">Off: analysis only. On: acks, closes and escalates New Relic alerts for you</div>
    </div>
  );
}

const SKILL_LABELS = { claude: "Claude Code", cursor: "Cursor" } as const;
const SKILL_STATE_TEXT = { installed: "Installed", outdated: "Update available", missing: "Not installed" } as const;

function AgentSkillCard() {
  const utils = trpc.useUtils();
  const status = trpc.skill.status.useQuery();
  const install = trpc.skill.install.useMutation({ onSettled: () => utils.skill.status.invalidate() });

  return (
    <div className={theme.settingsCard + " w-80 space-y-3"}>
      <div>
        <div className="font-medium">Agent skill</div>
        <div className="text-xs opacity-60">Let Claude Code or Cursor run Tracer investigations from your editor.</div>
      </div>
      {status.error && <div className={theme.errorText}>{status.error.message}</div>}
      {status.data?.map((s) => (
        <div key={s.target} className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm">
              {SKILL_LABELS[s.target]} <span className="text-xs opacity-60">{SKILL_STATE_TEXT[s.state]}</span>
            </div>
            <div className={theme.metaText + " truncate"}>{s.path}</div>
          </div>
          <button
            onClick={() => install.mutate(s.target)}
            disabled={s.state === "installed" || install.isPending}
            className={theme.secondaryBtn}
          >
            {s.state === "outdated" ? "Update" : s.state === "installed" ? "Installed" : "Install"}
          </button>
        </div>
      ))}
      {install.error && <div className={theme.errorText}>{install.error.message}</div>}
    </div>
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
      >
        <AlertTriageRow />
      </IntegrationCard>
      <AgentSkillCard />
    </div>
  );
}
