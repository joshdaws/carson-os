/**
 * Shared ChatBubble component used by Onboarding and ProfileInterview.
 *
 * Renders assistant messages with markdown + optional richContent slot.
 * User messages render as plain text with navy bg / cream text.
 */

import { cn } from "@/lib/utils";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  richContent?: React.ReactNode;
}

export function ChatBubble({
  message,
  richContent,
}: {
  message: ChatMessage;
  richContent?: React.ReactNode;
}) {
  const isUser = message.role === "user";
  const renderedRichContent = richContent ?? message.richContent;

  return (
    <div className={cn("flex mb-4", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mr-3"
          style={{ background: "var(--carson-navy)", color: "var(--carson-cream)" }}
        >
          C
        </div>
      )}
      <div
        className={cn("max-w-[70%] rounded-lg px-4 py-3 text-sm leading-relaxed")}
        style={
          isUser
            ? { background: "var(--carson-navy)", color: "var(--carson-cream)" }
            : {
                background: "var(--carson-white)",
                color: "var(--carson-text)",
                border: "1px solid var(--carson-border)",
              }
        }
      >
        {isUser ? (
          <span style={{ whiteSpace: "pre-wrap" }}>{message.content}</span>
        ) : (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              strong: ({ children }) => (
                <strong className="font-semibold">{children}</strong>
              ),
              ol: ({ children }) => (
                <ol className="list-decimal ml-4 mb-2 space-y-1">{children}</ol>
              ),
              ul: ({ children }) => (
                <ul className="list-disc ml-4 mb-2 space-y-1">{children}</ul>
              ),
              li: ({ children }) => <li>{children}</li>,
              h1: ({ children }) => (
                <h1 className="text-lg font-semibold mb-2">{children}</h1>
              ),
              h2: ({ children }) => (
                <h2 className="text-base font-semibold mb-2">{children}</h2>
              ),
              h3: ({ children }) => (
                <h3 className="text-sm font-semibold mb-1">{children}</h3>
              ),
            }}
          >
            {message.content}
          </Markdown>
        )}

        {/* Rich content renders below the text, inside the bubble boundary */}
        {renderedRichContent && (
          <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--carson-border)" }}>
            {renderedRichContent}
          </div>
        )}
      </div>
    </div>
  );
}
