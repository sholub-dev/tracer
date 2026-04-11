import { useCurrentFrame, interpolate } from "remotion";
import { palette } from "../styles/palette";

interface ChatMessageProps {
  label: string;
  labelColor?: string;
  children: React.ReactNode;
  fadeInFrame: number;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  label,
  labelColor = palette.textSecondary,
  children,
  fadeInFrame,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [fadeInFrame, fadeInFrame + 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const translateY = interpolate(frame, [fadeInFrame, fadeInFrame + 8], [10, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        opacity,
        transform: `translateY(${translateY}px)`,
        marginBottom: 20,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.15em",
          color: labelColor,
          marginBottom: 6,
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 16,
          lineHeight: 1.8,
          color: palette.textBody,
          fontFamily: "Georgia, serif",
        }}
      >
        {children}
      </div>
    </div>
  );
};
