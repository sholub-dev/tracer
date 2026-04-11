import { theme, colors } from "../../lib/theme";
import { AVAILABLE_MODELS } from "../../lib/models";

export function PricingTable({ configuredProviders }: { configuredProviders: Set<string> }) {
  return (
    <div className="border-t border-[#e8e6e1]">
      <table className="w-full text-sm">
        <thead>
          <tr className={theme.tableHeaderRow}>
            <th className={theme.tableHeaderCell + " text-xs py-2"}>Model</th>
            <th className={theme.tableHeaderCell + " text-xs py-2"}>Provider</th>
            <th className={theme.tableHeaderCell + " text-xs py-2 text-right"}>Input ($/M)</th>
            <th className={theme.tableHeaderCell + " text-xs py-2 text-right"}>Output ($/M)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#e8e6e1]">
          {AVAILABLE_MODELS.map((m) => {
            const active = configuredProviders.has(m.provider);
            return (
              <tr key={m.modelId} style={active ? { color: colors.success } : { color: colors.inkFaint }}>
                <td className="px-4 py-2 font-mono text-xs">{m.modelId}</td>
                <td className="px-4 py-2 capitalize">{m.provider}</td>
                <td className="px-4 py-2 text-right font-mono text-xs">
                  ${m.inputPrice.toFixed(2)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-xs">
                  ${m.outputPrice.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
