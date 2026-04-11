import { useCurrentFrame, interpolate } from "remotion";
import { palette } from "../styles/palette";

export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();

  const logoOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const taglineOpacity = interpolate(frame, [12, 28], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const logoY = interpolate(frame, [0, 20], [15, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        width: 1280,
        height: 720,
        backgroundColor: palette.shell,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
      }}
    >
      <div
        style={{
          opacity: logoOpacity,
          transform: `translateY(${logoY}px)`,
          fontSize: 64,
          fontWeight: 800,
          color: palette.accent,
          letterSpacing: "0.08em",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        OKO
      </div>
      <div
        style={{
          opacity: taglineOpacity,
          fontSize: 18,
          color: palette.textSecondary,
          fontFamily: "Georgia, serif",
          fontStyle: "italic",
        }}
      >
        Local-first AI-powered observability.
      </div>
    </div>
  );
};
