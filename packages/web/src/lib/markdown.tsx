import { createContext, useContext, type ReactNode } from "react";
import { Streamdown, type CustomRendererProps } from "streamdown";
import { RESULT_FENCE } from "@tracer-sh/shared";
import { cn } from "@/lib/utils";

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

/** Finds the query a ```result block names in the reply it sits in, or null when there is none. */
export type ResultLookup = (title: string) => ReactNode | null;

const ResultLookupContext = createContext<ResultLookup | null>(null);
export const ResultLookupProvider = ResultLookupContext.Provider;

// A block that still streams is the tail of the reply, so it renders nothing until it closes; nothing below it can move.
function ResultBlock({ code, isIncomplete }: CustomRendererProps) {
  const lookup = useContext(ResultLookupContext);
  if (isIncomplete) return null;
  const title = code.trim();
  return lookup?.(title) ?? <p className="my-2 text-[13px]/[18px] text-muted-foreground">Chart: {title}</p>;
}

const PLUGINS = { renderers: [{ language: RESULT_FENCE, component: ResultBlock }] };

export function Markdown({ text, isAnimating = false, className }: { text: string; isAnimating?: boolean; className?: string }) {
  return (
    // Long unbroken tokens (class names, ids, URLs) would otherwise run past the edge on a phone.
    <div className={cn("[overflow-wrap:break-word]", className)}>
      <Streamdown isAnimating={isAnimating} controls={CONTROLS} linkSafety={LINK_SAFETY} components={COMPONENTS} plugins={PLUGINS}>{text}</Streamdown>
    </div>
  );
}
