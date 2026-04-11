import { useRef } from "react";
import { useScrollFade } from "../../lib/hooks";

export function ScrollableList({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { showTopFade, showBottomFade } = useScrollFade(ref);

  return (
    <div className="relative">
      <div
        className={`absolute top-0 left-0 right-0 h-6 bg-gradient-to-b from-[#f7f6f3] to-transparent z-10 pointer-events-none transition-opacity ${showTopFade ? "opacity-100" : "opacity-0"}`}
      />
      <div ref={ref} className="max-h-[300px] overflow-y-auto scrollbar-none">
        {children}
      </div>
      <div
        className={`absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-[#f7f6f3] to-transparent z-10 pointer-events-none transition-opacity ${showBottomFade ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}
