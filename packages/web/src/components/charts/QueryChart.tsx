import { useEffect, useMemo, useRef, useState } from "react";
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
  /** Size the plot to `height` and let the box grow to fit the legend below it. */
  growWithLegend?: boolean;
}

export function QueryChart({ provider, query, height, className, refreshKey = 0, threshold, chartType, growWithLegend = false }: QueryChartProps) {
  const executeMutation = trpc.provider.executeQuery.useMutation();
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  // Refreshes keep the previous result on screen; a new query (e.g. range change) overlays a spinner.
  const showSpinner = loading && data === null && error === null;
  const showOverlay = loading && !showSpinner && loadedQuery !== query;
  const mountedRef = useRef(true);
  const { ref, size } = useContainerSize();
  // 36 = the legend + padding reserve ChartContainer subtracts from the given height.
  const boxHeight = growWithLegend && height ? height + 36 : size.height;
  const containerSize = useMemo(
    () => (size.width > 0 && boxHeight > 0 ? { width: size.width, height: boxHeight } : undefined),
    [size.width, boxHeight],
  );

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    executeMutation.mutate(
      { provider, query },
      {
        onSuccess: (result) => {
          if (mountedRef.current) { setData(result); setError(null); setLoadedQuery(query); setLoading(false); }
        },
        onError: (err) => {
          if (mountedRef.current) { setError(err.message); setLoadedQuery(query); setLoading(false); }
        },
      },
    );
    return () => { mountedRef.current = false; };
  }, [provider, query, refreshKey]);

  return (
    <div
      ref={ref}
      className={`relative ${className ?? ""}`}
      style={growWithLegend ? { minHeight: showSpinner ? height : undefined } : { height, ...(height ? {} : { flex: 1, minHeight: 0 }) }}
    >
      {showOverlay && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60">
          <Spinner size="sm" />
        </div>
      )}
      {showSpinner ? (
        <div className="flex items-center justify-center h-full">
          <Spinner size="sm" />
        </div>
      ) : error ? (
        <div className={`text-xs ${theme.errorText} p-2`}>{error}</div>
      ) : (
        <ResultView
          data={data}
          containerSize={containerSize}
          threshold={threshold}
          chartType={chartType}
        />
      )}
    </div>
  );
}
