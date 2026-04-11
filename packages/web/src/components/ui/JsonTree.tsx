import { JsonView, collapseAllNested, defaultStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

const collapseAll = () => false;

export function JsonTree({ data, collapsed }: { data: unknown; collapsed?: boolean }) {
  return (
    <div className="text-xs font-mono">
      <JsonView data={data as Record<string, unknown>} shouldExpandNode={collapsed ? collapseAll : collapseAllNested} style={defaultStyles} />
    </div>
  );
}
