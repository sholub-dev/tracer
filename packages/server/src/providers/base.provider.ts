import type {
  IProvider,
  PingResult,
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
  abstract executeRawQuery(query: string): Promise<unknown>;
}
