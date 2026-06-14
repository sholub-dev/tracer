import { theme } from "../lib/theme";
import { AiModelsSection } from "../components/settings/AiModelsSection";
import { DataProvidersSection } from "../components/settings/DataProvidersSection";
import { IntegrationsSection } from "../components/settings/IntegrationsSection";
import { AgentMemorySection } from "../components/settings/AgentMemorySection";
import { AgentConfigSection } from "../components/settings/AgentConfigSection";

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
        <h3 className={theme.sectionTitle}>Integrations</h3>
        <IntegrationsSection />
      </div>

      <div>
        <h3 className={theme.sectionTitle}>Agent Configuration</h3>
        <AgentConfigSection />
      </div>

      <div>
        <h3 className={theme.sectionTitle}>Agent Memory</h3>
        <AgentMemorySection />
      </div>
    </div>
  );
}
