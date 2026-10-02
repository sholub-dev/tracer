import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "../../lib/trpc";
import { Group, Row, Section } from "./parts";

const TIMEZONES = [
  "Pacific/Auckland",
  "Australia/Sydney",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/Moscow",
  "Europe/Berlin",
  "UTC",
  "Europe/London",
  "America/Sao_Paulo",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Pacific/Honolulu",
];

function tzLabel(tz: string): string {
  const part = (style: "short" | "shortOffset") =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: style })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  try {
    return `${part("short")} (${part("shortOffset")})`;
  } catch {
    return tz;
  }
}

const LIMITS = [
  { key: "directModeMaxSteps", label: "Steps per answer", description: "Most tool calls the agent makes for one answer", min: 1, max: 500, step: 1 },
  { key: "subAgentMaxSteps", label: "Steps per data source", description: "Most queries one data source agent runs per question", min: 1, max: 500, step: 1 },
  { key: "thinkingBudgetGoogle", label: "Thinking budget, Google", description: "Tokens the model may spend reasoning before it answers", min: 0, max: 100000, step: 256 },
  { key: "thinkingBudgetAnthropic", label: "Thinking budget, Anthropic", description: "Tokens the model may spend reasoning before it answers", min: 0, max: 100000, step: 1000 },
] as const;

type Values = { timezone: string } & Record<(typeof LIMITS)[number]["key"], number>;

export function AgentSettings() {
  const utils = trpc.useUtils();
  const { data: config } = trpc.settings.getAgentConfig.useQuery();
  const save = trpc.settings.saveAgentConfig.useMutation({
    onSuccess: () => {
      utils.settings.getAgentConfig.invalidate();
      setJustSaved(true);
      toast.success("Agent settings saved");
    },
    onError: (e) => toast.error(e.message),
  });
  const [values, setValues] = useState<Values | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (config) setValues({ ...config });
  }, [config]);

  const dirty = !!config && !!values && (Object.keys(values) as (keyof Values)[]).some((k) => values[k] !== config[k]);
  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((v) => v && { ...v, [key]: value });
    setJustSaved(false);
  };

  const zones = values && !TIMEZONES.includes(values.timezone) ? [...TIMEZONES, values.timezone] : TIMEZONES;

  return (
    <Section title="Agent" description="How long the agent may work on a question and how it reads time.">
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (values && dirty) save.mutate(values);
        }}
      >
        <Group>
          <Row
            label="Time zone"
            description="Used for times in answers and monitor schedules"
            htmlFor="timezone"
            control={
              values ? (
                <Select value={values.timezone} onValueChange={(v) => set("timezone", v)}>
                  <SelectTrigger id="timezone" className="w-48 bg-card">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end" position="popper">
                    {zones.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tzLabel(tz)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Skeleton className="h-9 w-48" />
              )
            }
          />
          {LIMITS.map((l) => (
            <Row
              key={l.key}
              label={l.label}
              description={l.description}
              htmlFor={l.key}
              control={
                values ? (
                  <Input
                    id={l.key}
                    type="number"
                    inputMode="numeric"
                    min={l.min}
                    max={l.max}
                    step={l.step}
                    value={values[l.key]}
                    onChange={(e) => set(l.key, Number(e.target.value))}
                    className="w-28 bg-card text-right tabular-nums"
                  />
                ) : (
                  <Skeleton className="h-9 w-28" />
                )
              }
            />
          ))}
        </Group>
        <div className="flex items-center justify-end gap-3">
          {justSaved && !dirty && (
            <span role="status" className="flex items-center gap-1.5 text-[13px]/[18px] text-success animate-in fade-in duration-200">
              <Check className="size-4" aria-hidden="true" />
              Saved
            </span>
          )}
          <Button type="submit" disabled={!dirty || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            {save.isPending ? "Saving" : "Save changes"}
          </Button>
        </div>
      </form>
    </Section>
  );
}
