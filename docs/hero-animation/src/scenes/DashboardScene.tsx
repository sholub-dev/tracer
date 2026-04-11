import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { AppShell } from "../components/AppShell";
import { palette } from "../styles/palette";

// Line chart data — response time trending up
const LINE_DATA = [12, 18, 15, 22, 28, 35, 32, 38, 42, 45, 40, 48, 52, 50, 55];
// Bar chart data — errors by service
const BAR_DATA = [45, 32, 28, 22, 18, 12];

const TIME_RANGES = ["30 min", "1 hour", "3 hours", "24 hours", "7 days", "30 days"];
const ACTIVE_RANGE = "24 hours";

export const DashboardScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Widget slide-in animations
  const widget1Spring = spring({
    frame: frame - 5,
    fps,
    config: { damping: 15, stiffness: 120, mass: 0.8 },
  });
  const widget2Spring = spring({
    frame: frame - 12,
    fps,
    config: { damping: 15, stiffness: 120, mass: 0.8 },
  });

  // Chart draw progress
  const lineProgress = interpolate(frame, [10, 35], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const barProgress = interpolate(frame, [17, 40], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const lineMax = Math.max(...LINE_DATA);
  const barMax = Math.max(...BAR_DATA);

  return (
    <AppShell
      activePage="dashboard"
      fadeInFrame={0}
      sessionItems={[{ label: "New Dashboard", active: true }]}
      newItemLabel="New dashboard"
      monitorAlertCount={1}
    >
      {/* Header — matches real Dashboard header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "16px 24px",
          backgroundColor: palette.white,
          borderBottom: `1px solid ${palette.border}`,
        }}
      >
        <span
          style={{
            fontSize: 18,
            fontWeight: 600,
            color: palette.textPrimary,
            fontFamily: "Inter, system-ui, sans-serif",
          }}
        >
          New Dashboard
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {TIME_RANGES.map((t) => (
            <span
              key={t}
              style={{
                fontSize: 11,
                padding: "4px 8px",
                borderRadius: 4,
                fontWeight: 500,
                fontFamily: "Inter, system-ui, sans-serif",
                ...(t === ACTIVE_RANGE
                  ? { backgroundColor: palette.accent, color: palette.white }
                  : {
                      color: palette.textSecondary,
                      border: `1px solid ${palette.border}`,
                    }),
              }}
            >
              {t}
            </span>
          ))}
          <span
            style={{
              marginLeft: 8,
              fontSize: 12,
              color: palette.textSecondary,
              fontFamily: "Inter, system-ui, sans-serif",
            }}
          >
            Hide Chat
          </span>
        </div>
      </div>

      {/* Content area with grid + chat panel */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Grid area */}
        <div
          style={{
            flex: 1,
            padding: 16,
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            flexWrap: "wrap",
            backgroundColor: palette.shell,
            minWidth: 0,
            overflow: "auto",
          }}
        >
          {/* Widget 1: Response Time line chart */}
          <div
            style={{
              opacity: interpolate(widget1Spring, [0, 1], [0, 1]),
              transform: `translateY(${interpolate(widget1Spring, [0, 1], [30, 0])}px)`,
              width: 440,
              height: 280,
              backgroundColor: palette.white,
              border: `1px solid ${palette.border}`,
              borderRadius: 4,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 16px",
                borderBottom: `1px solid ${palette.borderLight}`,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: palette.textSecondary,
                  fontFamily: "Inter, system-ui, sans-serif",
                }}
              >
                Error Rate (%)
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ fontSize: 12, color: palette.textSecondary }}>↻</span>
                <span style={{ fontSize: 12, color: palette.textSecondary }}>✕</span>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                padding: 12,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width={400} height={200} viewBox="0 0 400 200">
                {/* Grid lines */}
                {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
                  <line
                    key={pct}
                    x1={0}
                    y1={200 * (1 - pct)}
                    x2={400}
                    y2={200 * (1 - pct)}
                    stroke={palette.borderLight}
                    strokeWidth={1}
                  />
                ))}
                {/* Line + area */}
                {(() => {
                  const visibleCount = Math.ceil(lineProgress * LINE_DATA.length);
                  const points = LINE_DATA.slice(0, visibleCount).map((val, i) => ({
                    x: (i / (LINE_DATA.length - 1)) * 400,
                    y: 200 - (val / lineMax) * 180,
                  }));
                  if (points.length < 2) return null;
                  const lineStr = points.map((p) => `${p.x},${p.y}`).join(" ");
                  const areaStr = [
                    `0,200`,
                    ...points.map((p) => `${p.x},${p.y}`),
                    `${points[points.length - 1].x},200`,
                  ].join(" ");
                  return (
                    <>
                      <polygon points={areaStr} fill={palette.chart[0]} opacity={0.08} />
                      <polyline
                        points={lineStr}
                        fill="none"
                        stroke={palette.chart[0]}
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </>
                  );
                })()}
              </svg>
            </div>
          </div>

          {/* Widget 2: Errors by Service bar chart */}
          <div
            style={{
              opacity: interpolate(widget2Spring, [0, 1], [0, 1]),
              transform: `translateY(${interpolate(widget2Spring, [0, 1], [30, 0])}px)`,
              width: 300,
              height: 280,
              backgroundColor: palette.white,
              border: `1px solid ${palette.border}`,
              borderRadius: 4,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 16px",
                borderBottom: `1px solid ${palette.borderLight}`,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: palette.textSecondary,
                  fontFamily: "Inter, system-ui, sans-serif",
                }}
              >
                Errors by Service
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{ fontSize: 12, color: palette.textSecondary }}>↻</span>
                <span style={{ fontSize: 12, color: palette.textSecondary }}>✕</span>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                padding: 12,
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {BAR_DATA.map((val, i) => {
                const barH = (val / barMax) * 200 * barProgress;
                return (
                  <div
                    key={i}
                    style={{
                      width: 36,
                      height: barH,
                      backgroundColor: palette.chart[i % palette.chart.length],
                      borderRadius: "3px 3px 0 0",
                      opacity: 0.85,
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Dashboard Builder chat panel (right side) */}
        <div
          style={{
            width: 260,
            borderLeft: `1px solid ${palette.border}`,
            backgroundColor: palette.white,
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 16px",
              borderBottom: `1px solid ${palette.border}`,
            }}
          >
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: palette.textPrimary,
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              Dashboard Builder
            </span>
          </div>
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span
              style={{
                fontSize: 14,
                color: palette.textSecondary,
                fontStyle: "italic",
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              Create a widget...
            </span>
          </div>
          {/* Panel input */}
          <div
            style={{
              padding: "12px 16px",
              borderTop: `1px solid ${palette.border}`,
              display: "flex",
              gap: 8,
            }}
          >
            <div
              style={{
                flex: 1,
                border: `1px solid ${palette.border}`,
                borderRadius: 4,
                padding: "8px 12px",
                fontSize: 14,
                color: palette.textMuted,
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              Create a widget...
            </div>
            <div
              style={{
                padding: "8px 16px",
                backgroundColor: palette.accent,
                color: palette.white,
                borderRadius: 4,
                fontSize: 14,
                fontWeight: 500,
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              Send
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
};
