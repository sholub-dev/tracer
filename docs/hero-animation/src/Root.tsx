import { Composition } from "remotion";
import { HeroAnimation } from "./HeroAnimation";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="HeroAnimation"
      component={HeroAnimation}
      durationInFrames={330}
      fps={30}
      width={1280}
      height={720}
    />
  );
};
