import { Streamdown } from "streamdown";

// Module-level so Streamdown's memo sees stable props and skips re-rendering unchanged parts.
const CONTROLS = { code: true } as const;
const LINK_SAFETY = { enabled: false } as const;

// A model-written image URL would load without a click and leak data in its query string, so images render as links.
const COMPONENTS = {
  img: ({ src, alt }: { src?: string | Blob; alt?: string }) => {
    const href = typeof src === "string" && /^https?:\/\//i.test(src) ? src : undefined;
    const label = alt || href || "image";
    return href
      ? <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{label}</a>
      : <span>{label}</span>;
  },
};

export function Markdown({ text, isAnimating = false, className }: { text: string; isAnimating?: boolean; className?: string }) {
  return (
    <div className={className}>
      <Streamdown isAnimating={isAnimating} controls={CONTROLS} linkSafety={LINK_SAFETY} components={COMPONENTS}>{text}</Streamdown>
    </div>
  );
}
