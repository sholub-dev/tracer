import { useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { trpc } from "../../lib/trpc";
import { Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useContainerSize } from "../../lib/hooks";
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
  /** Reshapes array results before they render. */
  transform?: (rows: Record<string, unknown>[]) => Record<string, unknown>[];
}

export function QueryChart({ provider, query, height, className, refreshKey = 0, threshold, chartType, growWithLegend = false, transform }: QueryChartProps) {
  const utils = trpc.useUtils();
  // POST mutation: a GET batch of every chart's query can overflow the URL, and GETs are cross-site triggerable.
  const result = useQuery({
    queryKey: ["provider.executeQuery", provider, query],
    queryFn: () => utils.client.provider.executeQuery.mutate({ provider, query }),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
  });
  const { refetch } = result;
  const raw = result.data ?? null;
  const data = useMemo(() => (transform && Array.isArray(raw) ? transform(raw) : raw), [transform, raw]);
  const error = result.error?.message ?? null;
  // Refreshes keep the previous result on screen; a new query (e.g. range change) overlays a spinner.
  const showSpinner = result.isLoading;
  const showOverlay = result.isPlaceholderData;
  const { ref, size } = useContainerSize();
  // 36 = the legend + padding reserve ChartContainer subtracts from the given height.
  const boxHeight = growWithLegend && height ? height + 36 : size.height;
  const containerSize = useMemo(
    () => (size.width > 0 && boxHeight > 0 ? { width: size.width, height: boxHeight } : undefined),
    [size.width, boxHeight],
  );

  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return;
    lastRefreshKey.current = refreshKey;
    // Join an in-flight fetch (e.g. the query text changed too) instead of issuing a duplicate.
    void refetch({ cancelRefetch: false });
  }, [refreshKey, refetch]);

  return (
    <div
      ref={ref}
      className={`relative ${className ?? ""}`}
      style={growWithLegend ? { minHeight: showSpinner ? height : undefined } : { height, ...(height ? {} : { flex: 1, minHeight: 0 }) }}
    >
      {showOverlay && (
        <div role="status" aria-label="Loading" className="absolute inset-0 z-10 flex items-center justify-center bg-background/60">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {showSpinner ? (
        <Skeleton role="status" aria-label="Loading" className="h-full w-full" style={growWithLegend ? { height } : undefined} />
      ) : error ? (
        <div role="alert" className="p-2 text-[13px] leading-[18px] text-destructive">{error}</div>
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
