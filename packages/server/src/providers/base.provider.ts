import type {
  IProvider,
  OkoError,
  OkoLogEntry,
  OkoTransaction,
  PingResult,
  TimeRange,
} from "@oko/shared";

export abstract class BaseProvider implements IProvider {
  abstract readonly name: string;
  abstract readonly type: string;

  connected = false;
  lastChecked: string | null = null;

  abstract initialize(): Promise<void>;
  abstract testConnection(): Promise<boolean>;
  abstract ping(): Promise<PingResult>;
  abstract dispose(): Promise<void>;
  abstract getErrors(timeRange: TimeRange): Promise<OkoError[]>;
  abstract getTransactions(timeRange: TimeRange): Promise<OkoTransaction[]>;
  abstract getLogs(timeRange: TimeRange, filter?: string): Promise<OkoLogEntry[]>;
  abstract executeRawQuery(query: string): Promise<unknown>;
}
