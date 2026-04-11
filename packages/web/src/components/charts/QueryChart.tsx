import { useEffect, useRef, useState } from "react";
import { trpc } from "../../lib/trpc";
import { theme } from "../../lib/theme";
import { useContainerSize } from "../../lib/hooks";
import { Spinner } from "../ui/Spinner";
import ResultView from "./ResultView";
import type { Threshold } from "./ChartView";

interface QueryChartProps {
  provider: string;
  query: string;
  height?: number;
  className?: string;
  /** Increment to force a re-fetch without changing the query */
  refreshKey?: number;
  threshold?: Threshold;
  chartType?: string;
}

export function QueryChart({ provider, query, height, className, refreshKey = 0, threshold, chartType }: QueryChartProps) {
  const executeMutation = trpc.provider.executeQuery.useMutation();
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const { ref, size } = useContainerSize();

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setError(null);
    executeMutation.mutate(
      { provider, query },
      {
        onSuccess: (result) => {
          if (mountedRef.current) { setData(result); setLoading(false); }
        },
        onError: (err) => {
          if (mountedRef.current) { setError(err.message); setLoading(false); }
        },
      },
    );
    return () => { mountedRef.current = false; };
  }, [provider, query, refreshKey]);

  return (
    <div
      ref={ref}
      className={className}
      style={{ height, ...(height ? {} : { flex: 1, minHeight: 0 }) }}
    >
      {loading ? (
        <div className="flex items-center justify-center h-full">
          <Spinner size="sm" />
        </div>
      ) : error ? (
        <div className={`text-xs ${theme.errorText} p-2`}>{error}</div>
      ) : (
        <ResultView
          data={data}
          containerSize={size.width > 0 && size.height > 0 ? size : undefined}
          threshold={threshold}
          chartType={chartType}
        />
      )}
    </div>
  );
}
