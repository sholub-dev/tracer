import type {
  IProvider,
  TracerError,
  TracerLogEntry,
  TracerTransaction,
  PingResult,
  TimeRange,
} from "@tracer-sh/shared";

export abstract class BaseProvider implements IProvider {
  abstract readonly name: string;
  abstract readonly type: string;

  connected = false;
  lastChecked: string | null = null;

  abstract initialize(): Promise<void>;
  abstract testConnection(): Promise<boolean>;
  abstract ping(): Promise<PingResult>;
  abstract dispose(): Promise<void>;
  abstract getErrors(timeRange: TimeRange): Promise<TracerError[]>;
  abstract getTransactions(timeRange: TimeRange): Promise<TracerTransaction[]>;
  abstract getLogs(timeRange: TimeRange, filter?: string): Promise<TracerLogEntry[]>;
  abstract executeRawQuery(query: string): Promise<unknown>;
}
