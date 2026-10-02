import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { trpc } from "../../lib/trpc";
import { ConnectionRow, Group, Row, Section, Status, type ConfigField } from "./parts";
import { JIRA_NOTE, SLACK_NOTE } from "./notes";

// Classic Atlassian API token: it uses the account's Jira permissions; Tracer limits actions at the tool layer.
const JIRA_FIELDS: ConfigField[] = [
  { key: "domain", label: "Domain (yourco → yourco.atlassian.net)", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "apiToken", label: "API token", type: "password" },
];

const SLACK_FIELDS: ConfigField[] = [
  { key: "webhookUrl", label: "Webhook URL", type: "password" },
  { key: "mentions", label: "Tag on every alert (member IDs, @here, @channel)", type: "text", required: false },
];

export function IntegrationsSettings() {
  const utils = trpc.useUtils();
  const jira = trpc.integrations.getJira.useQuery();
  const slack = trpc.integrations.getSlack.useQuery();
  const onJira = { onSuccess: () => utils.integrations.getJira.invalidate() };
  const onSlack = { onSuccess: () => utils.integrations.getSlack.invalidate() };
  const saveJira = trpc.integrations.saveJira.useMutation(onJira);
  const removeJira = trpc.integrations.removeJira.useMutation(onJira);
  const saveSlack = trpc.integrations.saveSlack.useMutation(onSlack);
  const removeSlack = trpc.integrations.removeSlack.useMutation(onSlack);

  const slackOn = !!slack.data?.configured;
  const jiraOn = !!jira.data?.configured;
  const jiraDomain = jira.data?.config?.domain;

  return (
    <Section title="Integrations" description="Where Tracer posts its findings and files follow-up work.">
      <Group>
        {slack.isLoading || jira.isLoading ? (
          [0, 1].map((i) => (
            <div key={i} className="flex min-h-14 items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-8 w-24" />
            </div>
          ))
        ) : (
          <>
            <ConnectionRow
              name="Slack"
              detail="Posts monitor analyses to your channel"
              tone={slackOn ? "ok" : "off"}
              status={slackOn ? "Connected" : "Not connected"}
              connected={slackOn}
              fields={SLACK_FIELDS}
              existingConfig={slack.data?.config ?? null}
              note={SLACK_NOTE}
              pending={saveSlack.isPending || removeSlack.isPending}
              onSave={(v) => saveSlack.mutateAsync({ webhookUrl: v.webhookUrl ?? "", mentions: v.mentions ?? "" })}
              remove={{
                label: "Disconnect",
                title: "Disconnect Slack?",
                description: "Monitors stop posting their findings to Slack.",
                onConfirm: () => removeSlack.mutateAsync(),
              }}
            >
              {slackOn && <AlertTriageRow />}
            </ConnectionRow>
            <ConnectionRow
              name="Jira"
              detail={jiraDomain ? (jiraDomain.includes(".") ? jiraDomain : `${jiraDomain}.atlassian.net`) : "Read issues and post comments"}
              tone={jiraOn ? "ok" : "off"}
              status={jiraOn ? "Connected" : "Not connected"}
              connected={jiraOn}
              fields={JIRA_FIELDS}
              existingConfig={jira.data?.config ?? null}
              note={JIRA_NOTE}
              pending={saveJira.isPending || removeJira.isPending}
              onSave={(v) => saveJira.mutateAsync({ domain: v.domain ?? "", email: v.email ?? "", apiToken: v.apiToken ?? "" })}
              remove={{
                label: "Disconnect",
                title: "Disconnect Jira?",
                description: "The agent can no longer read issues or post comments.",
                onConfirm: () => removeJira.mutateAsync(),
              }}
            />
          </>
        )}
      </Group>
      <AgentSkillGroup />
    </Section>
  );
}

function AlertTriageRow() {
  const utils = trpc.useUtils();
  const { data: enabled } = trpc.settings.getAlertTriage.useQuery();
  const save = trpc.settings.setAlertTriage.useMutation({ onSettled: () => utils.settings.getAlertTriage.invalidate() });
  if (enabled === undefined) return null;
  return (
    <div className="flex items-start gap-4 border-t py-3 pr-4 pl-8">
      <div className="min-w-0 flex-1 text-[13px]/[18px] text-muted-foreground">
        <label htmlFor="alert-triage" className="text-sm font-medium text-foreground">
          Alert triage
        </label>
        <p className="mt-0.5">
          <strong className="font-semibold text-ink-2">Off:</strong> monitors post their analysis to Slack as usual.
          Nothing changes in New Relic.
        </p>
        <p>
          <strong className="font-semibold text-ink-2">On:</strong> Tracer acts on the New Relic issue behind each alert
          of monitors on NrAiIncident:
        </p>
        <ul className="mt-1 ml-4 list-disc space-y-0.5">
          <li>Stopped: acks, then closes it (JSM closes its alert). Pings you if severity is high.</li>
          <li>
            Ongoing or recurring: no ack, no close, so JSM keeps escalating. Pings you; the agent sets its own follow-up
            timer and acks and closes it once it stops.
          </li>
          <li>Status unknown or close failed: leaves it open, pings you.</li>
          <li>Closed 3 times in 24h and it keeps coming back: stops closing, pings you.</li>
          <li>Still ongoing after 24h: stops following up, pings you.</li>
        </ul>
      </div>
      <Switch
        id="alert-triage"
        checked={enabled}
        disabled={save.isPending}
        onCheckedChange={(v) => {
          utils.settings.getAlertTriage.setData(undefined, v);
          save.mutate({ enabled: v }, { onSuccess: () => toast(v ? "Alert triage is on" : "Alert triage is off") });
        }}
        className="mt-0.5"
      />
    </div>
  );
}

const SKILL_LABELS = { claude: "Claude Code", cursor: "Cursor" } as const;
const SKILL_STATE = {
  installed: { tone: "ok", text: "Installed" },
  outdated: { tone: "warn", text: "Update available" },
  missing: { tone: "off", text: "Not installed" },
} as const;

function AgentSkillGroup() {
  const utils = trpc.useUtils();
  const status = trpc.skill.status.useQuery();
  const install = trpc.skill.install.useMutation({
    onSettled: () => utils.skill.status.invalidate(),
    onSuccess: (_, target) => toast.success(`Installed in ${SKILL_LABELS[target]}`),
    onError: (e) => toast.error(e.message),
  });

  return (
    <Group title="Agent skill">
      {status.error && <p className="px-4 py-3 text-[13px]/[18px] text-destructive">{status.error.message}</p>}
      {status.isLoading && (
        <div className="flex min-h-14 items-center px-4 py-3">
          <Skeleton className="h-4 w-48" />
        </div>
      )}
      {status.data?.map((s) => {
        const state = SKILL_STATE[s.state];
        const busy = install.isPending && install.variables === s.target;
        return (
          <Row
            key={s.target}
            label={SKILL_LABELS[s.target]}
            description={
              <>
                Run Tracer investigations from {s.target === "claude" ? "your terminal" : "the editor chat"}
                <span className="mt-0.5 block truncate font-mono text-xs">{s.path}</span>
              </>
            }
            control={
              <div className="flex items-center gap-4">
                <Status tone={state.tone}>{state.text}</Status>
                {s.state !== "installed" && (
                  <Button variant="outline" size="sm" disabled={install.isPending} onClick={() => install.mutate(s.target)}>
                    {busy && <Loader2 className="animate-spin" />}
                    {s.state === "outdated" ? (busy ? "Updating" : "Update") : busy ? "Installing" : "Install"}
                  </Button>
                )}
              </div>
            }
          />
        );
      })}
    </Group>
  );
}
