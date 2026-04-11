import { useCurrentFrame } from "remotion";
import { palette } from "../styles/palette";

interface TypingAnimationProps {
  text: string;
  startFrame: number;
  charsPerFrame?: number;
  style?: React.CSSProperties;
  color?: string;
}

export const TypingAnimation: React.FC<TypingAnimationProps> = ({
  text,
  startFrame,
  charsPerFrame = 0.8,
  style,
  color = palette.textPrimary,
}) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startFrame);
  const visibleChars = Math.min(Math.floor(elapsed * charsPerFrame), text.length);
  const displayText = text.slice(0, visibleChars);
  const showCursor = visibleChars < text.length && elapsed > 0;

  return (
    <span style={{ color, ...style }}>
      {displayText}
      {showCursor && (
        <span
          style={{
            display: "inline-block",
            width: 2,
            height: "1em",
            backgroundColor: palette.accent,
            marginLeft: 1,
            verticalAlign: "text-bottom",
            opacity: Math.sin(elapsed * 0.3) > 0 ? 1 : 0,
          }}
        />
      )}
    </span>
  );
};
