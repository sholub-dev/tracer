import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import { palette } from "../styles/palette";

interface MonitorCardProps {
  name: string;
  status: "alert" | "ok";
  query: string;
  timestamp: string;
  fadeInFrame: number;
}

export const MonitorCard: React.FC<MonitorCardProps> = ({
  name,
  status,
  query,
  timestamp,
  fadeInFrame,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const entrance = spring({
    frame: frame - fadeInFrame,
    fps,
    config: { damping: 14, stiffness: 150, mass: 0.7 },
  });

  const opacity = interpolate(entrance, [0, 1], [0, 1]);
  const scale = interpolate(entrance, [0, 1], [0.95, 1]);

  const badgePulse =
    status === "alert"
      ? interpolate(
          Math.sin((frame - fadeInFrame) * 0.15),
          [-1, 1],
          [0.8, 1],
        )
      : 1;

  return (
    <div
      style={{
        opacity,
        transform: `scale(${scale})`,
        backgroundColor: palette.white,
        border: `1px solid ${palette.border}`,
        borderRadius: 6,
        padding: 20,
        width: 420,
        fontFamily: "Inter, system-ui, sans-serif",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: palette.textPrimary }}>
          {name}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            padding: "3px 10px",
            borderRadius: 9999,
            opacity: badgePulse,
            backgroundColor:
              status === "alert" ? palette.errorBg : `${palette.success}15`,
            color: status === "alert" ? palette.error : palette.success,
          }}
        >
          {status === "alert" ? "ALERT" : "OK"}
        </span>
      </div>

      {/* Query */}
      <div
        style={{
          fontSize: 11,
          fontFamily: "monospace",
          color: palette.textBody,
          backgroundColor: palette.cardBg,
          padding: "8px 12px",
          borderRadius: 4,
          marginBottom: 10,
          border: `1px solid ${palette.border}`,
        }}
      >
        {query}
      </div>

      {/* Timestamp */}
      <div style={{ fontSize: 11, color: palette.textSecondary }}>
        Triggered {timestamp}
      </div>
    </div>
  );
};
