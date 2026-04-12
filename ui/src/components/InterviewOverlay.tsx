/**
 * InterviewOverlay — reusable full-screen modal for focused chat interviews.
 *
 * Used by: Constitution builder, personality interview, profile interview.
 * Stateless: parent pages manage their own messages/mutations.
 * Escape key and backdrop click close the overlay.
 */

import { useRef, useEffect } from "react";
import { X, RotateCcw, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatBubble } from "@/components/ChatBubble";
import type { ChatMessage } from "@/components/ChatBubble";

interface InterviewOverlayProps {
  title: string;
  subtitle?: string;
  isOpen: boolean;
  onClose: () => void;
  onComplete?: () => void;
  messages: ChatMessage[];
  isLoading: boolean;
  isComplete: boolean;
  onSendMessage: (text: string) => void;
  onReset?: () => void;
}

export function InterviewOverlay({
  title,
  subtitle,
  isOpen,
  onClose,
  onComplete,
  messages,
  isLoading,
  isComplete,
  onSendMessage,
  onReset,
}: InterviewOverlayProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // Focus input when overlay opens
  useEffect(() => {
    if (isOpen && !isComplete) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, isComplete]);

  // Escape key closes
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement> | React.KeyboardEvent<HTMLTextAreaElement>) {
    e.preventDefault();
    const textarea = inputRef.current;
    if (!textarea) return;
    const text = textarea.value.trim();
    if (!text || isLoading) return;
    onSendMessage(text);
    textarea.value = "";
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(26, 31, 46, 0.6)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col w-full max-w-2xl rounded-lg overflow-hidden"
        style={{
          maxHeight: "85vh",
          background: "var(--carson-ivory, #faf8f4)",
          border: "1px solid var(--carson-border, #ddd5c8)",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        }}
      >
        {/* Header */}
        <div
          className="px-5 py-4 flex items-center justify-between border-b shrink-0"
          style={{ borderColor: "#ddd5c8", background: "#ffffff" }}
        >
          <div>
            <h3
              className="text-base font-normal"
              style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              {title}
            </h3>
            {subtitle && (
              <p className="text-xs mt-0.5" style={{ color: "#6b6358" }}>
                {subtitle}
              </p>
            )}
          </div>
          <div className="flex gap-1">
            {onReset && messages.length > 0 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={onReset}
                title="Start over"
              >
                <RotateCcw className="h-4 w-4" style={{ color: "#6b6358" }} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onClose}
              title="Close"
            >
              <X className="h-4 w-4" style={{ color: "#6b6358" }} />
            </Button>
          </div>
        </div>

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {messages.map((msg, i) => (
            <ChatBubble key={i} message={msg} />
          ))}
          {isLoading && (
            <div className="flex items-center gap-2 mb-4">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                style={{ background: "var(--carson-navy, #1a1f2e)", color: "var(--carson-cream, #e8dfd0)" }}
              >
                C
              </div>
              <div
                className="rounded-lg px-4 py-3"
                style={{ background: "#ffffff", border: "1px solid #ddd5c8" }}
              >
                <Loader2 className="h-4 w-4 animate-spin" style={{ color: "#6b6358" }} />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        {!isComplete ? (
          <form
            onSubmit={handleSubmit}
            className="px-5 py-4 border-t flex gap-2 items-end shrink-0"
            style={{ borderColor: "#ddd5c8", background: "#ffffff" }}
          >
            <Textarea
              ref={inputRef}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder="Type your answer..."
              className="flex-1 min-h-[44px] max-h-[120px] resize-none"
              style={{ borderColor: "#ddd5c8" }}
              rows={2}
              disabled={isLoading}
            />
            <Button
              type="submit"
              disabled={isLoading}
              style={{ background: "#1a1f2e", color: "#e8dfd0" }}
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        ) : (
          <div
            className="px-5 py-4 border-t text-center shrink-0"
            style={{ borderColor: "#ddd5c8", background: "#ffffff" }}
          >
            <p className="text-sm" style={{ color: "#2e7d32" }}>
              Interview complete.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => {
                onComplete?.();
                onClose();
              }}
              style={{ borderColor: "#ddd5c8" }}
            >
              Done
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
