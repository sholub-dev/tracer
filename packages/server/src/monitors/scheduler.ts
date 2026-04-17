import { eq, and, isNull } from "drizzle-orm";
import { substituteTimeRange, unixNow } from "@tracer-sh/shared";
import type { Db } from "../db/client.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { monitors, monitorAlerts } from "../db/schema.js";
import { evaluateCondition } from "./condition.js";
import { CONFIG } from "../config.js";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export class MonitorScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<void> | null = null;

  constructor(
    private db: Db,
    private providers: ProviderRegistry,
  ) {}

  start(): void {
    if (this.interval) return;
    console.log(`MonitorScheduler started (tick every ${CONFIG.monitorTickIntervalMs / 1000}s)`);
    this.interval = setInterval(() => {
      if (this.tickPromise) return; // skip if previous tick still running
      this.tickPromise = this.tick().finally(() => { this.tickPromise = null; });
    }, CONFIG.monitorTickIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.tickPromise) {
      console.log("MonitorScheduler waiting for current tick to finish...");
      await this.tickPromise;
    }
    console.log("MonitorScheduler stopped");
  }

  private async tick(): Promise<void> {
    try {
      const enabledMonitors = this.db
        .select()
        .from(monitors)
        .where(eq(monitors.enabled, 1))
        .all();

      const now = unixNow();

      // Batch-fetch all active (unresolved) alert monitor IDs in one query
      const activeAlertMonitorIds = new Set(
        this.db.select({ monitorId: monitorAlerts.monitorId })
          .from(monitorAlerts)
          .where(isNull(monitorAlerts.resolvedAt))
          .all()
          .map(r => r.monitorId)
      );

      const checks = enabledMonitors
        .filter((monitor) => {
          // Skip monitors with unresolved alerts — they pause until manually resolved
          if (activeAlertMonitorIds.has(monitor.id)) return false;

          // Align to clock boundaries: a 60s monitor runs at :00, :01, :02, etc.
          // A 300s monitor runs at :00, :05, :10, etc.
          const currentWindow = Math.floor(now / monitor.frequencySeconds);
          const lastWindow = monitor.lastCheckedAt
            ? Math.floor(monitor.lastCheckedAt / monitor.frequencySeconds)
            : -1;
          return currentWindow !== lastWindow;
        })
        .map((monitor) => this.checkMonitor(monitor, now));

      await Promise.allSettled(checks);
    } catch (err) {
      console.error("MonitorScheduler tick error:", err);
    }
  }

  private setMonitorStatus(monitorId: string, status: string, now: number): void {
    this.db
      .update(monitors)
      .set({ lastStatus: status, lastCheckedAt: now, updatedAt: now })
      .where(eq(monitors.id, monitorId))
      .run();
  }

  private async checkMonitor(
    monitor: typeof monitors.$inferSelect,
    now: number,
  ): Promise<void> {
    const provider = this.providers.getProvider(monitor.provider);
    if (!provider?.connected) {
      console.warn(`[monitor] "${monitor.name}" provider not connected, skipping`);
      this.setMonitorStatus(monitor.id, "error", now);
      return;
    }

    // Hydrate query placeholders with lookback window
    const lookbackSeconds = monitor.frequencySeconds * 2;
    const query = substituteTimeRange(monitor.query, `${lookbackSeconds} seconds ago`);

    console.log(`[monitor] checking "${monitor.name}" (every ${monitor.frequencySeconds}s)`);

    let result: unknown;
    try {
      result = await withTimeout(provider.executeRawQuery(query), CONFIG.monitorQueryTimeoutMs, `monitor "${monitor.name}"`);
    } catch (err) {
      console.warn(`[monitor] "${monitor.name}" query error:`, err);
      this.setMonitorStatus(monitor.id, "error", now);
      return;
    }

    const triggered = evaluateCondition(monitor.condition, result);

    // null = condition syntax error (broken config) — set error status, skip alert
    if (triggered === null) {
      this.setMonitorStatus(monitor.id, "error", now);
      return;
    }

    console.log(`[monitor] "${monitor.name}" → ${triggered ? "ALERT" : "ok"} (result: ${JSON.stringify(result)})`);

    if (triggered) {
      // 3a guarantees no active alert exists at this point
      this.db
        .insert(monitorAlerts)
        .values({
          id: crypto.randomUUID(),
          monitorId: monitor.id,
          triggeredAt: now,
          resultSnapshot: JSON.stringify(result),
          createdAt: now,
        })
        .run();
      this.setMonitorStatus(monitor.id, "alert", now);
    } else {
      this.setMonitorStatus(monitor.id, "ok", now);
    }
  }

}
