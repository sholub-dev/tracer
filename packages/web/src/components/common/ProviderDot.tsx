import { cn } from "@/lib/utils";
import { providerColorClass } from "../../lib/providers";

export function ProviderDot({ provider, className }: { provider: string; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", providerColorClass(provider), className)} />;
}
