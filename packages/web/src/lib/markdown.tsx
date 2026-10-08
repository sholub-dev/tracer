import { Streamdown } from "streamdown";

// Module-level so Streamdown's memo sees stable props and skips re-rendering unchanged parts.
const CONTROLS = { code: true } as const;
const LINK_SAFETY = { enabled: false } as const;

// A model-written image URL would load without a click and leak data in its query string, so images render as links.
// A model-written link can hide where it leads, so the tooltip shows the destination host and every link opens in a new, isolated tab.
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function linkTitle(href: string): string | undefined {
  try {
    const url = new URL(href);
    return LINK_PROTOCOLS.has(url.protocol) ? (url.protocol === "mailto:" ? url.pathname : url.host) : undefined;
  } catch {
    return undefined;
  }
}

const COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
    const title = href ? linkTitle(href) : undefined;
    return title === undefined
      ? <span>{children}</span>
      : <a href={href} title={title} target="_blank" rel="noopener noreferrer nofollow" className="underline">{children}</a>;
  },
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
