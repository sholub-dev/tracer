import { useState, useMemo } from "react";
import { usePolling } from "../lib/hooks";
import { theme } from "../lib/theme";
import { trpc } from "../lib/trpc";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { MonitorChatPanel } from "../components/monitors/MonitorChatPanel";
import { QueryChart } from "../components/charts/QueryChart";
import { TimeRangePicker } from "../components/ui/TimeRangePicker";
import { Badge } from "../components/ui/Badge";
import { ToggleSwitch } from "../components/ui/ToggleSwitch";
import { DEFAULT_SINCE, DEFAULT_UNTIL } from "../lib/nrql-utils";
import { substituteTimeRange } from "@oko/shared";
import { MONITOR_PRESETS, timeseriesClause, parseThreshold, formatTime, resolveQueryDisplay, statusVariant } from "../lib/monitor-utils";

export function Monitors() {
  const [chatOpen, setChatOpen] = useState<boolean | null>(null);
  const [expandedMonitors, setExpandedMonitors] = useState<Set<string>>(new Set());
  const [monitorSince, setMonitorSince] = useState<Record<string, string>>({});

  const monitorsQuery = trpc.monitors.list.useQuery();
  const activeAlertsQuery = trpc.monitorAlerts.activeAlerts.useQuery();
  const resolveMutation = trpc.monitorAlerts.resolve.useMutation();
  const deleteMutation = trpc.monitors.delete.useMutation();
  const utils = trpc.useUtils();

  const invalidateMonitorData = () => {
    utils.monitors.list.invalidate();
    utils.monitorAlerts.activeAlerts.invalidate();
    utils.monitorAlerts.activeCount.invalidate();
    utils.monitors.shouldPoll.invalidate();
  };

  const toggleEnabledMutation = trpc.monitors.toggleEnabled.useMutation({
    onSuccess: () => {
      utils.monitors.list.invalidate();
      utils.monitors.shouldPoll.invalidate();
    },
  });

  const monitors = monitorsQuery.data ?? [];
  const activeAlerts = activeAlertsQuery.data ?? [];

  // Default: show chat if no monitors, hide if monitors exist. Manual toggle overrides.
  const isChatOpen = chatOpen ?? monitors.length === 0;

  const alertsByMonitor = useMemo(() => {
    const map = new Map<string, typeof activeAlerts>();
    for (const alert of activeAlerts) {
      const list = map.get(alert.monitorId) ?? [];
      list.push(alert);
      map.set(alert.monitorId, list);
    }
    return map;
  }, [activeAlerts]);

  const shouldPoll = monitors.some(m => m.enabled && !alertsByMonitor.has(m.id));
  usePolling(invalidateMonitorData, 60_000, shouldPoll);

  const toggleMonitorChart = (monitorId: string) => {
    setExpandedMonitors((prev) => {
      const next = new Set(prev);
      if (next.has(monitorId)) next.delete(monitorId);
      else next.add(monitorId);
      return next;
    });
  };

  const handleResolve = (alertId: string) => {
    resolveMutation.mutate(
      { id: alertId },
      { onSuccess: invalidateMonitorData },
    );
  };

  const handleToggleEnabled = (monitorId: string, newEnabled: boolean) => {
    toggleEnabledMutation.mutate({ id: monitorId, enabled: newEnabled });
  };

  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleDelete = (monitorId: string) => {
    setDeleteId(monitorId);
  };

  const confirmDelete = () => {
    if (!deleteId) return;
    deleteMutation.mutate(
      { id: deleteId },
      { onSuccess: invalidateMonitorData },
    );
    setDeleteId(null);
  };

  return (
    <div className="flex flex-col h-full">
      <div className={`flex items-center justify-between px-6 py-4 ${theme.header}`}>
        <span className={theme.headerTitle}>Monitors</span>
        <button
          type="button"
          onClick={() => setChatOpen(!isChatOpen)}
          className={theme.secondaryBtn}
        >
          {isChatOpen ? "Hide Chat" : "Show Chat"}
        </button>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-auto p-4 bg-[#fafaf8]">
          {monitors.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-[#666666] text-sm font-sans mb-2">No monitors yet</p>
                <p className="text-[#666666] text-xs font-sans">
                  Use the chat to create monitors
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {monitors.map((monitor) => {
                const monitorAlerts = alertsByMonitor.get(monitor.id) ?? [];
                return (
                  <div key={monitor.id} className={theme.card}>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-medium text-[#2c2c2c] font-sans">
                        {monitor.name}
                      </span>
                      <div className="flex items-center gap-3">
                        <Badge variant={statusVariant(monitor.lastStatus)}>{monitor.lastStatus.toUpperCase()}</Badge>
                        <button
                          type="button"
                          onClick={() => toggleMonitorChart(monitor.id)}
                          className="text-xs text-[#666666] hover:text-[#2b5ea7] transition-colors font-sans"
                        >
                          {expandedMonitors.has(monitor.id) ? "Hide Chart" : "Show Chart"}
                        </button>
                        <ToggleSwitch
                          checked={!!monitor.enabled}
                          onChange={(enabled) => handleToggleEnabled(monitor.id, enabled)}
                        />
                        <button
                          type="button"
                          onClick={() => handleDelete(monitor.id)}
                          className="text-xs text-[#666666] hover:text-[#b33a2a] transition-colors font-sans"
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5 text-xs font-sans">
                      <div>
                        <span className="text-[#666666]">Query: </span>
                        <code className="text-[#444444] bg-[#f5f4f0] px-1.5 py-0.5 rounded text-[11px] font-mono">
                          {(() => {
                            const resolved = resolveQueryDisplay(monitor.query, monitor.frequencySeconds);
                            return resolved.length > 140 ? resolved.slice(0, 140) + "..." : resolved;
                          })()}
                        </code>
                      </div>
                      <div>
                        <span className="text-[#666666]">Condition: </span>
                        <code className="text-[#444444] bg-[#f5f4f0] px-1.5 py-0.5 rounded text-[11px] font-mono">
                          {monitor.condition}
                        </code>
                      </div>
                      <div className="flex gap-4 text-[#666666]">
                        <span>Every {monitor.frequencySeconds}s</span>
                        <span>Last check: {formatTime(monitor.lastCheckedAt)}</span>
                        <span>Provider: {monitor.provider}</span>
                      </div>
                    </div>

                    {expandedMonitors.has(monitor.id) && (
                      <div className="mt-3 pt-3 border-t border-[#e8e6e1]">
                        <TimeRangePicker
                          value={monitorSince[monitor.id] ?? DEFAULT_SINCE}
                          onChange={(v) => setMonitorSince((prev) => ({ ...prev, [monitor.id]: v }))}
                          presets={MONITOR_PRESETS}
                        />
                        <QueryChart
                          provider={monitor.provider}
                          query={substituteTimeRange(monitor.query, monitorSince[monitor.id] ?? DEFAULT_SINCE, DEFAULT_UNTIL)
                            + " " + timeseriesClause(monitor.frequencySeconds, monitorSince[monitor.id] ?? DEFAULT_SINCE)}
                          height={180}
                          className="mt-2"
                          threshold={parseThreshold(monitor.condition)}
                        />
                      </div>
                    )}

                    {monitorAlerts.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-[#e8e6e1]">
                        <div className="text-[9px] uppercase tracking-[0.15em] text-[#b33a2a] font-sans font-semibold mb-2">
                          Active Alerts
                        </div>
                        <div className="space-y-1.5">
                          {monitorAlerts.map((alert) => (
                            <div
                              key={alert.id}
                              className="flex items-center justify-between bg-[#b33a2a]/5 border border-[#b33a2a]/20 rounded px-3 py-2"
                            >
                              <span className="text-xs text-[#b33a2a] font-sans">
                                Triggered {formatTime(alert.triggeredAt)}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleResolve(alert.id)}
                                className="text-xs text-[#2b5ea7] hover:text-[#234d8a] font-sans font-medium"
                              >
                                Resolve
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <MonitorChatPanel className={isChatOpen ? "" : "hidden"} />
      </div>

      <ConfirmDialog
        open={deleteId !== null}
        title="Delete monitor"
        message="Delete this monitor and all its alerts?"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteId(null)}
      />
    </div>
  );
}
