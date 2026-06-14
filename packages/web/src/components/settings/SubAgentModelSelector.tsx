import { trpc } from "../../lib/trpc";
import { AVAILABLE_MODELS, type ModelRef } from "../../lib/models";
import { useAvailableModels } from "../../lib/hooks";
import { ModelSelect } from "./ModelSelect";

/** No override → the per-provider sub-agent falls back to this default model. */
const DEFAULT_MODEL: ModelRef = AVAILABLE_MODELS[0];

export function SubAgentModelSelector({ providerType }: { providerType: string }) {
  const utils = trpc.useUtils();
  const { data: subAgentModel, isLoading } = trpc.settings.getSubAgentModel.useQuery(providerType);
  const save = trpc.settings.saveSubAgentModel.useMutation({
    onSuccess: () => utils.settings.getSubAgentModel.invalidate(providerType),
  });
  const { models, isLoading: modelsLoading } = useAvailableModels();

  if (isLoading) return null;

  const value: ModelRef = subAgentModel ?? DEFAULT_MODEL;

  return (
    <ModelSelect
      value={value}
      models={models}
      loading={modelsLoading}
      disabled={save.isPending}
      onChange={(m) => save.mutate({ providerType, model: { provider: m.provider, modelId: m.modelId } })}
    />
  );
}
