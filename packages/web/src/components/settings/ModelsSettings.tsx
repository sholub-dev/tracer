import { useEffect, useId, useState, type ReactNode } from "react";
import { Loader2, TriangleAlert } from "lucide-react";

import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { trpc } from "../../lib/trpc";
import { IS_IOS } from "../../lib/platform";
import { useAvailableModels, useConfiguredProviders, useGcpAuthStatus } from "../../lib/hooks";
import { AVAILABLE_MODELS, effectivePrices, groupModelsByProvider, modelKey, llmProviderLabel } from "../../lib/models";
import { FoldTrigger } from "../common/FoldTrigger";
import { ConnectionRow, Group, Row, Section } from "./parts";
import { GOOGLE_AI_NOTE } from "./notes";
import { GcloudHint, GcpProjectField } from "./GcpProjectField";

export function ModelsSettings() {
  return (
    <Section title="Models" description="Pick the model that answers and the keys Tracer uses to call it.">
      <Group>
        <ModelRow />
      </Group>
      <Group title="API keys">
        <ApiKeyRow type="anthropic" label="Anthropic" />
        <ApiKeyRow type="google" label="Google AI" note={GOOGLE_AI_NOTE} />
        {!IS_IOS && <VertexRow />}
      </Group>
      <Pricing />
    </Section>
  );
}

function ModelRow() {
  const utils = trpc.useUtils();
  const { data: chatModel } = trpc.settings.getChatModel.useQuery();
  const save = trpc.settings.saveChatModel.useMutation({
    onSuccess: () => utils.settings.getChatModel.invalidate(),
  });
  const { models, isLoading } = useAvailableModels();

  if (!chatModel) return <Row label="Investigation model" control={<Skeleton className="h-9 w-56" />} />;

  const valueKey = modelKey(chatModel);
  const unavailable = !isLoading && !models.some((m) => modelKey(m) === valueKey);

  return (
    <Row
      label="Investigation model"
      htmlFor="chat-model"
      description={
        <>
          Used for chat, data source agents and titles
          {unavailable && (
            <span className="mt-1 flex items-start gap-1.5 text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {llmProviderLabel(chatModel.provider)} · {chatModel.modelId} isn’t available. Configure its provider or pick
              another model.
            </span>
          )}
        </>
      }
      control={
        <Select
          value={valueKey}
          disabled={save.isPending}
          onValueChange={(key) => {
            const i = key.indexOf(":");
            save.mutate({ provider: key.slice(0, i), modelId: key.slice(i + 1) });
          }}
        >
          <SelectTrigger id="chat-model" className="w-64 bg-card">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end" position="popper">
            {unavailable && (
              <SelectGroup>
                <SelectLabel>Unavailable</SelectLabel>
                <SelectItem value={valueKey}>{chatModel.modelId}</SelectItem>
              </SelectGroup>
            )}
            {groupModelsByProvider(models).map((g) => (
              <SelectGroup key={g.provider}>
                <SelectLabel>{g.label}</SelectLabel>
                {g.models.map((m) => (
                  <SelectItem key={modelKey(m)} value={modelKey(m)}>
                    {m.modelId}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

function ApiKeyRow({ type, label, note }: { type: string; label: string; note?: ReactNode }) {
  const utils = trpc.useUtils();
  const { data: existing, isLoading } = trpc.settings.getApiKey.useQuery(type);
  const saveKey = trpc.settings.saveApiKey.useMutation({ onSuccess: () => utils.settings.getApiKey.invalidate(type) });
  const removeKey = trpc.settings.removeApiKey.useMutation({ onSuccess: () => utils.settings.getApiKey.invalidate(type) });

  if (isLoading) return <Row label={label} control={<Skeleton className="h-8 w-40" />} />;

  return (
    <ConnectionRow
      name={label}
      detail={existing && <span className="font-mono text-xs">{existing.maskedApiKey}</span>}
      tone={existing ? "ok" : "off"}
      status={existing ? "Key saved" : "Not connected"}
      connected={!!existing}
      fields={[{ key: "apiKey", label: "API key", type: "password", placeholder: existing?.maskedApiKey ?? "Enter API key" }]}
      note={note}
      saveLabel="Save"
      successText="Key saved"
      pending={saveKey.isPending || removeKey.isPending}
      onSave={async (v) => {
        await saveKey.mutateAsync({ type, apiKey: v.apiKey ?? "" });
        return { success: true };
      }}
      remove={{
        label: "Remove",
        title: `Remove the ${label} API key?`,
        description: "Models from this provider stop working until you add a key again.",
        onConfirm: () => removeKey.mutateAsync(type),
      }}
    />
  );
}

function VertexRow() {
  const utils = trpc.useUtils();
  const { data: existing, isLoading } = trpc.settings.getVertexConfig.useQuery();
  const auth = useGcpAuthStatus();
  const invalidate = () => {
    utils.settings.getVertexConfig.invalidate();
    utils.provider.listVertexModels.invalidate();
  };
  const saveConfig = trpc.settings.saveVertexConfig.useMutation({ onSuccess: invalidate });
  const removeConfig = trpc.settings.removeVertexConfig.useMutation({ onSuccess: invalidate });
  const busy = saveConfig.isPending || removeConfig.isPending;

  if (isLoading) return <Row label="Vertex AI" control={<Skeleton className="h-8 w-40" />} />;

  const enabled = !!existing;
  const authOk = auth.data?.ok ?? false;
  const [tone, status] = !enabled
    ? (["off", "Not connected"] as const)
    : auth.isLoading
      ? (["off", "Checking"] as const)
      : authOk
        ? (["ok", "Connected"] as const)
        : (["warn", "Not signed in"] as const);

  return (
    <ConnectionRow
      name="Vertex AI"
      detail={
        existing?.projectId ? (
          <>
            Uses your gcloud login · <span className="font-mono text-xs">{existing.projectId}</span>
          </>
        ) : (
          "Uses your gcloud login"
        )
      }
      tone={tone}
      status={status}
      connected={enabled}
      pending={busy}
      successText="Enabled"
      onConnect={async () => {
        await saveConfig.mutateAsync({});
        return { success: true };
      }}
      remove={{
        label: "Disable",
        title: "Disable Vertex AI?",
        description: "Your project selection will be removed.",
        onConfirm: () => removeConfig.mutateAsync(),
      }}
      extra={
        auth.isLoading ? (
          <p className="flex items-center gap-2 text-[13px]/[18px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Checking authentication
          </p>
        ) : !authOk ? (
          <GcloudHint message={auth.data && !auth.data.ok ? auth.data.message : undefined} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <GcpProjectField
              value={existing?.projectId ?? ""}
              disabled={busy}
              onChange={(projectId) => saveConfig.mutate({ projectId })}
            />
            <LocationField
              value={existing?.location ?? "global"}
              disabled={busy}
              onCommit={(location) => {
                const loc = location.trim() || "global";
                if (loc !== existing?.location) saveConfig.mutate({ location: loc });
              }}
            />
          </div>
        )
      }
    />
  );
}

function LocationField({ value, onCommit, disabled }: { value: string; onCommit: (value: string) => void; disabled?: boolean }) {
  const id = useId();
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[13px]/[18px]">
        Location
      </Label>
      <Input
        id={id}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => onCommit(local)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        placeholder="global"
        disabled={disabled}
        className="bg-card"
      />
    </div>
  );
}

function Pricing() {
  const configured = useConfiguredProviders();
  return (
    <Collapsible className="rounded-lg border bg-card">
      <FoldTrigger className="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left text-sm font-medium" chevronClassName="size-4 text-muted-foreground">
        Model pricing
        <span className="ml-auto text-[13px]/[18px] font-normal text-muted-foreground">Per 1M tokens</span>
      </FoldTrigger>
      <CollapsibleContent>
        <div className="border-t">
          <Table className="text-[13px]/[18px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-xs text-muted-foreground">Model</TableHead>
                <TableHead className="text-xs text-muted-foreground">Provider</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">Input</TableHead>
                <TableHead className="pr-4 text-right text-xs text-muted-foreground">Output</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {AVAILABLE_MODELS.map((m) => {
                const { inputPrice, outputPrice } = effectivePrices(m);
                return (
                  <TableRow key={m.modelId} className={cn("hover:bg-transparent", !configured.has(m.provider) && "text-muted-foreground")}>
                    <TableCell className="pl-4 font-mono text-xs">{m.modelId}</TableCell>
                    <TableCell>{llmProviderLabel(m.provider)}</TableCell>
                    <TableCell className="text-right tabular-nums">${inputPrice.toFixed(2)}</TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">${outputPrice.toFixed(2)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
