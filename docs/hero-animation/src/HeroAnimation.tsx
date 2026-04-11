import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from "remotion";
import { DebugScene } from "./scenes/DebugScene";
import { DashboardScene } from "./scenes/DashboardScene";
import { MonitorsScene } from "./scenes/MonitorsScene";
import { OutroScene } from "./scenes/OutroScene";
import { palette } from "./styles/palette";

// 330 frames total at 30fps = 11 seconds
// Scene 1-3 (Debug):   frames 0-179   (6.0s)
// Scene 4 (Dashboard): frames 180-224 (1.5s)
// Scene 5 (Monitors):  frames 225-254 (1.0s)
// Scene 6 (Outro):     frames 255-329 (2.5s)

const CrossFade: React.FC<{
  children: React.ReactNode;
  fadeInDuration?: number;
  fadeOutStart: number;
  fadeOutDuration?: number;
}> = ({ children, fadeInDuration = 8, fadeOutStart, fadeOutDuration = 8 }) => {
  const frame = useCurrentFrame();

  const fadeIn = interpolate(frame, [0, fadeInDuration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const fadeOut = interpolate(
    frame,
    [fadeOutStart, fadeOutStart + fadeOutDuration],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill style={{ opacity: Math.min(fadeIn, fadeOut) }}>
      {children}
    </AbsoluteFill>
  );
};

export const HeroAnimation: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: palette.shell }}>
      {/* Debug Scene: frames 0-179 */}
      <Sequence from={0} durationInFrames={188}>
        <CrossFade fadeInDuration={15} fadeOutStart={172} fadeOutDuration={16}>
          <DebugScene />
        </CrossFade>
      </Sequence>

      {/* Dashboard Scene: frames 180-224 */}
      <Sequence from={180} durationInFrames={53}>
        <CrossFade fadeInDuration={8} fadeOutStart={37} fadeOutDuration={16}>
          <DashboardScene />
        </CrossFade>
      </Sequence>

      {/* Monitors Scene: frames 225-254 */}
      <Sequence from={225} durationInFrames={38}>
        <CrossFade fadeInDuration={8} fadeOutStart={22} fadeOutDuration={16}>
          <MonitorsScene />
        </CrossFade>
      </Sequence>

      {/* Outro: frames 255-329 */}
      <Sequence from={255} durationInFrames={75}>
        <CrossFade fadeInDuration={12} fadeOutStart={999} fadeOutDuration={1}>
          <OutroScene />
        </CrossFade>
      </Sequence>
    </AbsoluteFill>
  );
};
