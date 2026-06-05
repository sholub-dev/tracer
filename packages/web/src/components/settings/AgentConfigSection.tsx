import { useState, useEffect } from "react";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";

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
] as const;

function formatTzLabel(tz: string): string {
  try {
    const abbr = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? "";
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value ?? "";
    return `${abbr} (${offset})`;
  } catch {
    return tz;
  }
}

const TZ_LABELS = new Map(TIMEZONES.map((tz) => [tz, formatTzLabel(tz)]));

export function AgentConfigSection() {
  const utils = trpc.useUtils();
  const { data: config, isLoading } = trpc.settings.getAgentConfig.useQuery();
  const saveMutation = trpc.settings.saveAgentConfig.useMutation({
    onSuccess: () => {
      utils.settings.getAgentConfig.invalidate();
      setDirty(false);
    },
  });

  const [timezone, setTimezone] = useState("");
  const [directSteps, setDirectSteps] = useState(100);
  const [subAgentSteps, setSubAgentSteps] = useState(50);
  const [thinkingGoogle, setThinkingGoogle] = useState(1024);
  const [thinkingAnthropic, setThinkingAnthropic] = useState(10000);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (config) {
      setTimezone(config.timezone);
      setDirectSteps(config.directModeMaxSteps);
      setSubAgentSteps(config.subAgentMaxSteps);
      setThinkingGoogle(config.thinkingBudgetGoogle);
      setThinkingAnthropic(config.thinkingBudgetAnthropic);
      setDirty(false);
    }
  }, [config]);

  if (isLoading || !config) return null;

  const hasChanges = dirty && (
    timezone !== config.timezone ||
    directSteps !== config.directModeMaxSteps ||
    subAgentSteps !== config.subAgentMaxSteps ||
    thinkingGoogle !== config.thinkingBudgetGoogle ||
    thinkingAnthropic !== config.thinkingBudgetAnthropic
  );

  function handleSave() {
    saveMutation.mutate({
      timezone,
      directModeMaxSteps: directSteps,
      subAgentMaxSteps: subAgentSteps,
      thinkingBudgetGoogle: thinkingGoogle,
      thinkingBudgetAnthropic: thinkingAnthropic,
    });
  }

  function markDirty() {
    setDirty(true);
  }

  return (
    <div className="max-w-lg">
      <div className={theme.settingsCard}>
        <div className="space-y-3">
          {/* Timezone */}
          <div className="flex items-center gap-4">
            <label className="text-xs text-[#666666] w-44 shrink-0">Timezone</label>
            <select
              value={timezone}
              onChange={(e) => { setTimezone(e.target.value); markDirty(); }}
              className="appearance-none bg-white border border-[#d4d2cd] rounded px-3 py-1.5 text-xs text-[#2c2c2c] focus:outline-none focus:border-[#2b5ea7] font-sans"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{TZ_LABELS.get(tz) ?? tz}</option>
              ))}
              {!TIMEZONES.includes(timezone as typeof TIMEZONES[number]) && (
                <option value={timezone}>{formatTzLabel(timezone)}</option>
              )}
            </select>
          </div>

          {/* Direct mode max steps */}
          <div className="flex items-center gap-4">
            <label className="text-xs text-[#666666] w-44 shrink-0">Direct mode max steps</label>
            <input
              type="number"
              min={1}
              max={500}
              value={directSteps}
              onChange={(e) => { setDirectSteps(Number(e.target.value)); markDirty(); }}
              className="w-20 bg-white border border-[#d4d2cd] rounded px-3 py-1.5 text-xs text-[#2c2c2c] focus:outline-none focus:border-[#2b5ea7] font-mono"
            />
          </div>

          {/* Sub-agent max steps */}
          <div className="flex items-center gap-4">
            <label className="text-xs text-[#666666] w-44 shrink-0">Sub-agent max steps</label>
            <input
              type="number"
              min={1}
              max={500}
              value={subAgentSteps}
              onChange={(e) => { setSubAgentSteps(Number(e.target.value)); markDirty(); }}
              className="w-20 bg-white border border-[#d4d2cd] rounded px-3 py-1.5 text-xs text-[#2c2c2c] focus:outline-none focus:border-[#2b5ea7] font-mono"
            />
          </div>

          {/* Google thinking budget */}
          <div className="flex items-center gap-4">
            <label className="text-xs text-[#666666] w-44 shrink-0">Google thinking budget</label>
            <input
              type="number"
              min={0}
              max={100000}
              step={256}
              value={thinkingGoogle}
              onChange={(e) => { setThinkingGoogle(Number(e.target.value)); markDirty(); }}
              className="w-24 bg-white border border-[#d4d2cd] rounded px-3 py-1.5 text-xs text-[#2c2c2c] focus:outline-none focus:border-[#2b5ea7] font-mono"
            />
            <span className="text-[10px] text-[#9c9890]">tokens</span>
          </div>

          {/* Anthropic thinking budget */}
          <div className="flex items-center gap-4">
            <label className="text-xs text-[#666666] w-44 shrink-0">Anthropic thinking budget</label>
            <input
              type="number"
              min={0}
              max={100000}
              step={1000}
              value={thinkingAnthropic}
              onChange={(e) => { setThinkingAnthropic(Number(e.target.value)); markDirty(); }}
              className="w-24 bg-white border border-[#d4d2cd] rounded px-3 py-1.5 text-xs text-[#2c2c2c] focus:outline-none focus:border-[#2b5ea7] font-mono"
            />
            <span className="text-[10px] text-[#9c9890]">tokens</span>
          </div>

        </div>

        {/* Save button */}
        <div className="flex items-center gap-3 mt-4 pt-3 border-t border-[#e8e6e1]">
          <button
            onClick={handleSave}
            disabled={!hasChanges || saveMutation.isPending}
            className={theme.primaryBtn}
          >
            {saveMutation.isPending ? "Saving..." : "Save"}
          </button>
          {saveMutation.isSuccess && !dirty && (
            <span className={theme.successText}>Saved</span>
          )}
        </div>
      </div>
    </div>
  );
}
