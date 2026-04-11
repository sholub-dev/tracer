import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { palette } from "../styles/palette";

interface ChartWidgetProps {
  title: string;
  type: "line" | "bar";
  data: number[];
  color?: string;
  fadeInFrame: number;
  width?: number;
  height?: number;
}

export const ChartWidget: React.FC<ChartWidgetProps> = ({
  title,
  type,
  data,
  color = palette.chart[0],
  fadeInFrame,
  width = 340,
  height = 200,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const slideIn = spring({
    frame: frame - fadeInFrame,
    fps,
    config: { damping: 15, stiffness: 120, mass: 0.8 },
  });

  const opacity = interpolate(slideIn, [0, 1], [0, 1]);
  const translateY = interpolate(slideIn, [0, 1], [30, 0]);

  const chartPadding = { top: 10, right: 10, bottom: 10, left: 10 };
  const chartWidth = width - 32 - chartPadding.left - chartPadding.right;
  const chartHeight = height - 60 - chartPadding.top - chartPadding.bottom;
  const maxVal = Math.max(...data);

  // Animate chart drawing
  const drawProgress = interpolate(
    frame,
    [fadeInFrame + 5, fadeInFrame + 30],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const renderLineChart = () => {
    const points = data.map((val, i) => {
      const x = chartPadding.left + (i / (data.length - 1)) * chartWidth;
      const y = chartPadding.top + chartHeight - (val / maxVal) * chartHeight;
      return `${x},${y}`;
    });

    const visibleCount = Math.ceil(drawProgress * points.length);
    const visiblePoints = points.slice(0, visibleCount);

    // Area fill
    const areaPoints = [
      `${chartPadding.left},${chartPadding.top + chartHeight}`,
      ...visiblePoints,
      ...(visibleCount > 0
        ? [`${visiblePoints[visibleCount - 1]?.split(",")[0]},${chartPadding.top + chartHeight}`]
        : []),
    ].join(" ");

    return (
      <svg width={chartWidth + chartPadding.left + chartPadding.right} height={chartHeight + chartPadding.top + chartPadding.bottom}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
          <line
            key={pct}
            x1={chartPadding.left}
            y1={chartPadding.top + chartHeight * (1 - pct)}
            x2={chartPadding.left + chartWidth}
            y2={chartPadding.top + chartHeight * (1 - pct)}
            stroke={palette.borderLight}
            strokeWidth={1}
          />
        ))}
        {/* Area */}
        {visibleCount > 1 && (
          <polygon points={areaPoints} fill={color} opacity={0.1} />
        )}
        {/* Line */}
        {visibleCount > 1 && (
          <polyline
            points={visiblePoints.join(" ")}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    );
  };

  const renderBarChart = () => {
    const barWidth = chartWidth / data.length * 0.7;
    const gap = chartWidth / data.length * 0.3;

    return (
      <svg width={chartWidth + chartPadding.left + chartPadding.right} height={chartHeight + chartPadding.top + chartPadding.bottom}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
          <line
            key={pct}
            x1={chartPadding.left}
            y1={chartPadding.top + chartHeight * (1 - pct)}
            x2={chartPadding.left + chartWidth}
            y2={chartPadding.top + chartHeight * (1 - pct)}
            stroke={palette.borderLight}
            strokeWidth={1}
          />
        ))}
        {data.map((val, i) => {
          const barHeight = (val / maxVal) * chartHeight * drawProgress;
          const x = chartPadding.left + i * (barWidth + gap) + gap / 2;
          const y = chartPadding.top + chartHeight - barHeight;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={3}
              fill={palette.chart[i % palette.chart.length]}
              opacity={0.85}
            />
          );
        })}
      </svg>
    );
  };

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        width,
        height,
        backgroundColor: palette.white,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: `1px solid ${palette.borderLight}`,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: palette.textSecondary,
            fontFamily: "Inter, system-ui, sans-serif",
          }}
        >
          {title}
        </span>
      </div>
      {/* Chart */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "8px",
        }}
      >
        {type === "line" ? renderLineChart() : renderBarChart()}
      </div>
    </div>
  );
};
