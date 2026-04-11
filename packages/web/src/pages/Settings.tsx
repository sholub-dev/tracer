import { theme } from "../lib/theme";
import { AiModelsSection } from "../components/settings/AiModelsSection";
import { DataProvidersSection } from "../components/settings/DataProvidersSection";
import { AgentMemorySection } from "../components/settings/AgentMemorySection";

export function Settings() {
  return (
    <div className={theme.page}>
      <div>
        <h3 className={theme.sectionTitle}>LLM API Keys</h3>
        <AiModelsSection />
      </div>

      <div>
        <h3 className={theme.sectionTitle}>Data Providers</h3>
        <DataProvidersSection />
      </div>

      <div>
        <h3 className={theme.sectionTitle}>Agent Memory</h3>
        <AgentMemorySection />
      </div>
    </div>
  );
}
