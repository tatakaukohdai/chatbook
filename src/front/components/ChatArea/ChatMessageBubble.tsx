import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ChatMessage } from "../../../shared/schemas/chat";
import type { Citation } from "../../../shared/schemas/citation";
import { CitationLink } from "./CitationLink";
import { MARKDOWN_COMPONENTS, PlainAnchor, type AnchorProps } from "../markdownComponents";
import { stripSources } from "../../../shared/lib/stripSources";
import { citationIdFromHref, linkifyCitationRefs } from "../../lib/citationRefs";

/**
 * The `a` renderer for one answer: the markers `linkifyCitationRefs` rewrote
 * become citation links, everything else stays an ordinary link.
 *
 * Built per answer because the sources are what a marker is resolved against,
 * and defined out here so a re-render does not hand react-markdown a component
 * type it has never seen and remount the whole body.
 */
function citationAnchor(citations: Citation[] | null | undefined) {
  return function CitationAnchor(props: AnchorProps) {
    const id = citationIdFromHref(props.href);
    const citation = id === null ? undefined : citations?.find((c) => c.id === id);

    return citation ? <CitationLink citation={citation} /> : <PlainAnchor {...props} />;
  };
}

interface ChatMessageBubbleProps {
  /** Only what the bubble renders; a streaming answer has no id or timestamp yet. */
  message: Pick<ChatMessage, "role" | "content" | "citations">;
}

export function ChatMessageBubble({ message }: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const citations = message.citations;

  const components = useMemo(
    () => ({ ...MARKDOWN_COMPONENTS, a: citationAnchor(citations) }),
    [citations],
  );

  const body = useMemo(() => {
    const answer = stripSources(message.content);
    return citations && citations.length > 0
      ? linkifyCitationRefs(answer, new Set(citations.map((c) => c.id)))
      : answer;
  }, [message.content, citations]);

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-blue-600 text-white rounded-br-sm"
            : "bg-gray-100 text-gray-800 rounded-bl-sm"
        }`}
      >
        {isUser ? (
          // The user's own text is shown as typed, not interpreted as markdown
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : (
          <div className="break-words">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={components}
            >
              {body}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}
