import { useEffect } from "react";
import { theme } from "../../lib/theme";
import { trpc } from "../../lib/trpc";
import { DEFAULT_SUB_AGENT_KEY } from "../../lib/models";
import { useAvailableModels } from "../../lib/hooks";

export function SubAgentModelSelector({ providerType }: { providerType: string }) {
  const utils = trpc.useUtils();
  const { data: subAgentModel, isLoading } = trpc.settings.getSubAgentModel.useQuery(providerType);
  const saveSubAgentModel = trpc.settings.saveSubAgentModel.useMutation({
    onSuccess: () => utils.settings.getSubAgentModel.invalidate(providerType),
  });

  const availableModels = useAvailableModels();

  const currentKey = subAgentModel
    ? `${subAgentModel.provider}:${subAgentModel.modelId}`
    : DEFAULT_SUB_AGENT_KEY;
  const isKnown = availableModels.some((m) => `${m.provider}:${m.modelId}` === currentKey);
  const effectiveKey = isKnown ? currentKey : `${availableModels[0].provider}:${availableModels[0].modelId}`;

  useEffect(() => {
    if (!isLoading && subAgentModel && !isKnown) {
      saveSubAgentModel.mutate({ providerType, model: null });
    }
  }, [isLoading, isKnown]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return null;

  function handleChange(value: string) {
    if (value === DEFAULT_SUB_AGENT_KEY && !subAgentModel) return;
    const selected = availableModels.find((m) => `${m.provider}:${m.modelId}` === value);
    if (selected) {
      if (value === DEFAULT_SUB_AGENT_KEY) {
        saveSubAgentModel.mutate({ providerType, model: null });
      } else {
        saveSubAgentModel.mutate({ providerType, model: { provider: selected.provider, modelId: selected.modelId } });
      }
    }
  }

  return (
    <div className="flex items-center gap-3 mt-3 pt-3 border-t border-[#d4d2cd]">
      <span className="text-xs text-[#666666] whitespace-nowrap w-14">Model</span>
      <div className="relative flex-1">
        <select
          value={effectiveKey}
          onChange={(e) => handleChange(e.target.value)}
          disabled={saveSubAgentModel.isPending}
          className="w-full appearance-none bg-white border border-[#d4d2cd] rounded px-3 py-2 pr-7 text-xs text-[#2c2c2c] focus:outline-none focus:border-[#2b5ea7] font-sans disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {availableModels.map((m) => (
            <option key={`${m.provider}:${m.modelId}`} value={`${m.provider}:${m.modelId}`}>
              {m.modelId}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[#9c9890] text-[10px]">▾</span>
      </div>
    </div>
  );
}
