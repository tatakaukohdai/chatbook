import type { ElementType } from "react";
import type { ExtraProps } from "react-markdown";
import { MermaidBlock } from "./ChatArea/MermaidBlock";

/** The `<pre>` node react-markdown hands over, holding the fence's `<code>` child. */
type FenceNode = NonNullable<ExtraProps["node"]>;

/** The diagram source of a ```mermaid fence, or null for any other block. */
function mermaidFenceSource(node: FenceNode | undefined): string | null {
  const code = node?.children[0];
  if (code?.type !== "element") return null;

  // rehype-highlight leaves the fence's `language-mermaid` in place and adds
  // `hljs` next to it, so the class list has to be searched
  const classes = code.properties.className;
  if (!Array.isArray(classes) || !classes.includes("language-mermaid")) return null;

  const source = code.children[0];
  return source?.type === "text" ? source.value : null;
}

/**
 * A renderer that puts one class on one element and passes the rest through.
 *
 * react-markdown hands every renderer the mdast `node` the element was built
 * from. Spreading it onto the DOM element would write `node="[object Object]"`
 * into the markup, so it is dropped here once instead of at each element below.
 */
export function withClass(Tag: ElementType, className: string) {
  return function Styled({ node: _node, ...props }: ExtraProps) {
    return <Tag className={className} {...props} />;
  };
}

/** What react-markdown hands the `a` renderer, of which only `href` is read. */
export type AnchorProps = { href?: string } & ExtraProps;

/** A link the answer wrote itself, which always leaves the app. */
export function PlainAnchor({ node: _node, ...props }: AnchorProps) {
  return (
    <a className="text-blue-600 underline" target="_blank" rel="noopener noreferrer" {...props} />
  );
}

/**
 * How Markdown is dressed everywhere this app renders it: the chat's answers,
 * and the reader's own note.
 *
 * Shared so a heading in a note is the same size as a heading in an answer.
 * Tailwind resets the browser's defaults, so without these the markdown would
 * render as one undifferentiated block.
 */
export const MARKDOWN_COMPONENTS = {
  p: withClass("p", "mb-2 last:mb-0"),
  h1: withClass("h1", "mb-2 mt-3 text-base font-bold first:mt-0"),
  h2: withClass("h2", "mb-2 mt-3 text-sm font-bold first:mt-0"),
  h3: withClass("h3", "mb-1 mt-2 text-sm font-semibold first:mt-0"),
  ul: withClass("ul", "mb-2 list-disc pl-5 last:mb-0"),
  ol: withClass("ol", "mb-2 list-decimal pl-5 last:mb-0"),
  li: withClass("li", "mb-0.5"),
  strong: withClass("strong", "font-semibold"),
  a: PlainAnchor,
  // rehype-highlight prepends `hljs` to the fence's `language-x`, so the class
  // that marks a block has to be searched for rather than matched at the start
  code: ({ className, node: _node, ...props }: { className?: string } & ExtraProps) =>
    className?.includes("language-") ? (
      <code className={`block ${className}`} {...props} />
    ) : (
      <code
        className={`rounded bg-gray-200 px-1 py-0.5 font-mono text-[0.85em] ${className ?? ""}`}
        {...props}
      />
    ),
  // A mermaid fence is swapped for the diagram it describes. The swap happens
  // here rather than in `code` so the drawn diagram is not boxed inside the
  // dark <pre> a code block wears.
  //
  // A fence naming no language is left classless by rehype-highlight, so `code`
  // above reads it as inline and dresses it as a pale chip — unreadable against
  // this dark background. The chip is undressed from here, where the fence is
  // known to be a block. Fences highlight.js did touch keep their `hljs` look.
  pre: ({ node, ...props }: { node?: FenceNode }) => {
    const plain = (
      <pre
        className="mb-2 overflow-x-auto rounded bg-gray-800 p-2 font-mono text-xs text-gray-100 last:mb-0 [&_code:not(.hljs)]:block [&_code:not(.hljs)]:bg-transparent [&_code:not(.hljs)]:p-0"
        {...props}
      />
    );
    const diagram = mermaidFenceSource(node);
    return diagram === null ? plain : <MermaidBlock code={diagram} fallback={plain} />;
  },
  blockquote: withClass(
    "blockquote",
    "mb-2 border-l-2 border-gray-300 pl-2 text-gray-600 last:mb-0",
  ),
  // The only element that is not styled in place: the scroll box a wide table
  // needs has to sit outside the table itself
  table: ({ node: _node, ...props }: ExtraProps) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs" {...props} />
    </div>
  ),
  th: withClass("th", "border border-gray-300 px-2 py-1 text-left"),
  td: withClass("td", "border border-gray-300 px-2 py-1"),
  hr: withClass("hr", "my-2 border-gray-300"),
};
