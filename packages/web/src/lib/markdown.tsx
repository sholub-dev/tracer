import { Streamdown } from "streamdown";

// Module-level so Streamdown's memo sees stable props and skips re-rendering unchanged parts.
const CONTROLS = { code: true } as const;
const LINK_SAFETY = { enabled: false } as const;

export function Markdown({ text, isAnimating = false, className }: { text: string; isAnimating?: boolean; className?: string }) {
  return (
    <div className={className}>
      <Streamdown isAnimating={isAnimating} controls={CONTROLS} linkSafety={LINK_SAFETY}>{text}</Streamdown>
    </div>
  );
}
