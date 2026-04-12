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
              em: ({ children }) => <em className="italic">{children}</em>,
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
              code: ({ children, className }) => {
                const isBlock = className?.startsWith("language-");
                return isBlock ? (
                  <pre className="rounded p-3 mb-2 overflow-x-auto text-xs" style={{ background: "var(--carson-ivory, #faf8f4)" }}>
                    <code>{children}</code>
                  </pre>
                ) : (
                  <code className="rounded px-1 py-0.5 text-xs" style={{ background: "var(--carson-ivory, #faf8f4)" }}>
                    {children}
                  </code>
                );
              },
              pre: ({ children }) => <>{children}</>,
              blockquote: ({ children }) => (
                <blockquote className="border-l-2 pl-3 my-2 italic text-sm" style={{ borderColor: "var(--carson-accent, #8b6f4e)", color: "#6a6050" }}>
                  {children}
                </blockquote>
              ),
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: "var(--carson-accent, #8b6f4e)" }}>
                  {children}
                </a>
              ),
              hr: () => <hr className="my-3" style={{ borderColor: "var(--carson-border, #ddd5c8)" }} />,
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
