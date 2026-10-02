// Streamdown body: serif reading text capped at 68ch, sans subheadings, mono code, sans tables.
const BASE =
  "font-serif text-foreground [overflow-wrap:break-word] " +
  "[&_:is(p,ul,ol,blockquote)]:max-w-[68ch] " +
  "[&_:is(h1,h2,h3,h4,h5,h6)]:font-sans [&_:is(h1,h2,h3,h4,h5,h6)]:text-base [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:leading-snug [&_:is(h1,h2,h3,h4,h5,h6)]:mt-6 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-2 [&_:is(h1,h2,h3,h4,h5,h6):first-child]:mt-0 " +
  "[&_:is(ul,ol)]:list-outside [&_:is(ul,ol)]:pl-5 [&_li]:marker:text-muted-foreground [&_table]:font-sans [&_table]:text-sm " +
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.8em]";

export const ANSWER_PROSE = `${BASE} text-lg leading-[1.6]`;
export const ANSWER_PROSE_COMPACT = `${BASE} text-base leading-[1.6]`;
