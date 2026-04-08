/**
 * Profile Interview Wizard -- conversational profile builder for family members.
 *
 * Reuses the chat bubble pattern from Onboarding. Can be embedded in the
 * Household page or opened as a modal/drawer from a member card.
 */

import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Send, Loader2, X, RotateCcw } from "lucide-react";
import { ChatBubble } from "@/components/ChatBubble";
import type { ChatMessage } from "@/components/ChatBubble";

// ── Types ──────────────────────────────────────────────────────────

interface ProfileData {
  memberId: string;
  memberName: string;
  profileContent: string | null;
  profileUpdatedAt: string | null;
  interview: {
    phase: string;
    messageCount: number;
    messages: ChatMessage[];
  } | null;
}

// ── Profile Interview Wizard ──────────────────────────────────────

export function ProfileInterview({
  memberId,
  memberName,
  onClose,
  onComplete,
}: {
  memberId: string;
  memberName: string;
  onClose: () => void;
  onComplete?: () => void;
}) {
  const queryClient = useQueryClient();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [initialized, setInitialized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch existing profile/interview state
  const { data: profileData, isLoading } = useQuery<ProfileData>({
    queryKey: ["profile", memberId],
    queryFn: () => api.get(`/members/${memberId}/profile`),
    enabled: !!memberId,
  });

  // Hydrate messages from server (once)
  useEffect(() => {
    if (profileData && !initialized) {
      setInitialized(true);
      if (profileData.interview?.messages && profileData.interview.messages.length > 0) {
        setMessages(profileData.interview.messages);
      }
    }
  }, [profileData, initialized]);

  // Auto-start: kick off the interview if no messages exist
  useEffect(() => {
    if (!initialized || isLoading) return;
    const serverMessages = profileData?.interview?.messages || [];
    if (serverMessages.length === 0 && messages.length === 0) {
      sendMessage.mutate(`I'd like to tell you about ${memberName}.`);
    }
  }, [initialized, isLoading]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Send interview message
  const sendMessage = useMutation({
    mutationFn: (text: string) =>
      api.post<{ response: string; phase: string; profileDocument?: string }>(
        `/members/${memberId}/profile/interview`,
        { message: text },
      ),
    onSuccess: (data) => {
      setMessages((prev) => [...prev, { role: "assistant", content: data.response }]);
      if (data.profileDocument) {
        queryClient.invalidateQueries({ queryKey: ["profile", memberId] });
        queryClient.invalidateQueries({ queryKey: ["household"] });
        onComplete?.();
      }
    },
  });

  // Reset interview
  const resetMutation = useMutation({
    mutationFn: () => api.post(`/members/${memberId}/profile/reset`),
    onSuccess: () => {
      setMessages([]);
      setInitialized(false);
      queryClient.invalidateQueries({ queryKey: ["profile", memberId] });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || sendMessage.isPending) return;
    setMessages((prev) => [...prev, { role: "user", content: input.trim() }]);
    sendMessage.mutate(input.trim());
    setInput("");
  }

  const isComplete = profileData?.interview?.phase === "review_complete";

  return (
    <div
      className="flex flex-col rounded-lg border overflow-hidden"
      style={{ borderColor: "var(--carson-border)", height: "500px", background: "var(--carson-ivory)" }}
    >
      {/* Header */}
      <div
        className="px-4 py-3 flex items-center justify-between border-b shrink-0"
        style={{ borderColor: "#ddd5c8", background: "#ffffff" }}
      >
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "#1a1f2e" }}>
            Profile Interview: {memberName}
          </h3>
          <p className="text-[10px]" style={{ color: "#6b6358" }}>
            {isComplete
              ? "Profile complete"
              : "Carson will ask questions to build a profile"}
          </p>
        </div>
        <div className="flex gap-1">
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending}
              title="Start over"
            >
              <RotateCcw className="h-3.5 w-3.5" style={{ color: "#6b6358" }} />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-3.5 w-3.5" style={{ color: "#6b6358" }} />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {isLoading && (
          <p className="text-sm text-center" style={{ color: "#6b6358" }}>
            Loading...
          </p>
        )}
        {messages.map((msg, i) => (
          <ChatBubble key={i} message={msg} />
        ))}
        {sendMessage.isPending && (
          <div className="flex items-center gap-2 mb-4">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
              style={{ background: "#1a1f2e", color: "#e8dfd0" }}
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

      {/* Input */}
      {!isComplete && (
        <form
          onSubmit={handleSubmit}
          className="px-4 py-3 border-t flex gap-2 items-end shrink-0"
          style={{ borderColor: "#ddd5c8", background: "#ffffff" }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
            disabled={sendMessage.isPending}
            autoFocus
          />
          <Button
            type="submit"
            disabled={!input.trim() || sendMessage.isPending}
            style={{ background: "#1a1f2e", color: "#e8dfd0" }}
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      )}

      {/* Complete state */}
      {isComplete && (
        <div
          className="px-4 py-3 border-t text-center shrink-0"
          style={{ borderColor: "#ddd5c8", background: "#ffffff" }}
        >
          <p className="text-sm" style={{ color: "#2e7d32" }}>
            Profile saved for {memberName}.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={onClose}
            style={{ borderColor: "#ddd5c8" }}
          >
            Done
          </Button>
        </div>
      )}
    </div>
  );
}
