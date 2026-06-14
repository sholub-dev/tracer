import { trpc } from "../../lib/trpc";
import { useAvailableModels } from "../../lib/hooks";
import { ModelSelect } from "./ModelSelect";

/**
 * Model used by the cross-provider "ALL" / Unified chat scope (`chat_model` setting). Direct
 * (single-provider) mode uses each provider's own SubAgentModelSelector instead.
 */
export function UnifiedChatModelSelector() {
  const utils = trpc.useUtils();
  const { data: chatModel, isLoading } = trpc.settings.getChatModel.useQuery();
  const save = trpc.settings.saveChatModel.useMutation({
    onSuccess: () => utils.settings.getChatModel.invalidate(),
  });
  const { models, isLoading: modelsLoading } = useAvailableModels();

  if (isLoading || !chatModel) return null;

  return (
    <ModelSelect
      value={chatModel}
      models={models}
      loading={modelsLoading}
      disabled={save.isPending}
      onChange={(m) => save.mutate({ provider: m.provider, modelId: m.modelId })}
    />
  );
}
