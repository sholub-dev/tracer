import { useState } from "react";
import { Brain, Cpu, Database, Plug, SlidersHorizontal, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { ModelsSettings } from "../components/settings/ModelsSettings";
import { DataSourcesSettings } from "../components/settings/DataSourcesSettings";
import { IntegrationsSettings } from "../components/settings/IntegrationsSettings";
import { AgentSettings } from "../components/settings/AgentSettings";
import { MemorySettings } from "../components/settings/MemorySettings";

type Tab = "models" | "sources" | "integrations" | "agent" | "memory";

const TABS: { value: Tab; label: string; icon: LucideIcon; panel: () => React.JSX.Element }[] = [
  { value: "models", label: "Models", icon: Cpu, panel: ModelsSettings },
  { value: "sources", label: "Data sources", icon: Database, panel: DataSourcesSettings },
  { value: "integrations", label: "Integrations", icon: Plug, panel: IntegrationsSettings },
  { value: "agent", label: "Agent", icon: SlidersHorizontal, panel: AgentSettings },
  { value: "memory", label: "Memory", icon: Brain, panel: MemorySettings },
];

export function Settings() {
  const [tab, setTab] = useState<Tab>("models");
  const Panel = TABS.find((t) => t.value === tab)!.panel;

  return (
    <div className="min-h-full bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur-md">
        <div className="mx-auto max-w-[1000px] px-4 py-3 sm:px-6">
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row md:items-start md:gap-10 md:py-8">
        <nav aria-label="Settings sections" className="-mx-4 shrink-0 overflow-x-auto px-4 md:sticky md:top-20 md:mx-0 md:w-48 md:px-0">
          <ul className="flex gap-1 md:flex-col">
            {TABS.map(({ value, label, icon: Icon }) => (
              <li key={value}>
                <button
                  type="button"
                  aria-current={tab === value ? "page" : undefined}
                  onClick={() => setTab(value)}
                  className={cn(
                    "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-sm whitespace-nowrap text-ink-2 transition-colors duration-150 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                    tab === value && "bg-accent font-medium text-foreground hover:bg-accent",
                  )}
                >
                  <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 max-w-[720px] flex-1 pb-16">
          <Panel key={tab} />
        </div>
      </div>
    </div>
  );
}
