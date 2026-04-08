import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { MessageSquare, Send, User, Bot, ArrowLeft } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

// ── Types ──────────────────────────────────────────────────────────

interface HouseholdMember {
  id: string;
  name: string;
  role: string;
}

interface StaffAgent {
  id: string;
  name: string;
  staffRole: string;
}

interface HouseholdData {
  household: { id: string; name: string };
  members: HouseholdMember[];
}

interface Conversation {
  id: string;
  agentId: string;
  agentName?: string;
  memberId: string;
  memberName: string;
  channel: string;
  lastMessage: string;
  lastMessageAt: string;
  messageCount: number;
}

interface PolicyTag {
  clauseText: string;
  enforcementLevel: string;
  eventType: string;
}

interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  policyEvent?: PolicyTag | null;
}

// ── Helpers ────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

// ── Conversation Row ───────────────────────────────────────────────

function ConversationRow({
  conversation,
  isSelected,
  onClick,
}: {
  conversation: Conversation;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-4 py-3 transition-colors",
        isSelected ? "bg-[#f5f0e8]" : "hover:bg-[#faf8f4]",
      )}
      style={{ borderBottom: "1px solid #eee8dd" }}
    >
      <div className="flex items-center gap-2 mb-1">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0"
          style={{ background: "#f0ede6", color: "#8a8070" }}
        >
          {conversation.memberName.charAt(0)}
        </div>
        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm truncate block" style={{ color: "#1a1f2e" }}>
            {conversation.memberName}
          </span>
          <span className="text-[10px]" style={{ color: "#a09080" }}>
            {conversation.agentName || "Unknown"} &middot; {conversation.channel}
          </span>
        </div>
        <span className="text-[10px] shrink-0" style={{ color: "#a09080" }}>
          {relativeTime(conversation.lastMessageAt)}
        </span>
      </div>
      <p className="text-xs truncate pl-9" style={{ color: "#8a8070" }}>
        {conversation.lastMessage}
      </p>
    </button>
  );
}

// ── Message Bubble ─────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <span
          className="text-[10px] px-3 py-1 rounded-full"
          style={{ background: "#f0ede6", color: "#8a8070" }}
        >
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("flex mb-3", isUser ? "justify-end" : "justify-start")}>
      <div className="max-w-[75%]">
        <div
          className="rounded-lg px-3.5 py-2.5 text-sm leading-relaxed"
          style={
            isUser
              ? { background: "#1a1f2e", color: "#e8dfd0" }
              : { background: "#f0ede6", color: "#2c2c2c" }
          }
        >
          {message.content}
        </div>
        <div
          className={cn("flex items-center gap-2 mt-1", isUser ? "justify-end" : "justify-start")}
        >
          <span className="text-[10px]" style={{ color: "#a09080" }}>
            {formatTime(message.createdAt)}
          </span>
          {message.policyEvent && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-medium"
              style={{
                background: message.policyEvent.enforcementLevel === "hard" ? "#fce4ec" : "#fff3e0",
                color: message.policyEvent.enforcementLevel === "hard" ? "#c62828" : "#8b6f4e",
              }}
            >
              {message.policyEvent.eventType === "enforced"
                ? "blocked"
                : message.policyEvent.eventType === "escalated"
                  ? "escalated"
                  : "flagged"}
              : {message.policyEvent.clauseText}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Conversations Page ─────────────────────────────────────────────

export function ConversationsPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState("all");
  const [staffFilter, setStaffFilter] = useState("all");
  const [messageInput, setMessageInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch household
  const { data: householdData } = useQuery<HouseholdData>({
    queryKey: ["household"],
    queryFn: () => api.get("/households/current"),
    retry: false,
  });

  // Fetch staff
  const { data: staffData } = useQuery<{ staff: StaffAgent[] }>({
    queryKey: ["staff"],
    queryFn: () => api.get("/staff"),
    retry: false,
  });

  // Build query params
  const queryParams = new URLSearchParams();
  if (memberFilter !== "all") queryParams.set("memberId", memberFilter);
  if (staffFilter !== "all") queryParams.set("agentId", staffFilter);
  const queryString = queryParams.toString();

  // Fetch conversations
  const { data: convsData, isLoading: loadingConvs } = useQuery<{
    conversations: Conversation[];
  }>({
    queryKey: ["conversations", queryString],
    queryFn: () => api.get(`/conversations${queryString ? `?${queryString}` : ""}`),
  });

  // Fetch messages for selected conversation
  const { data: messagesData, isLoading: loadingMessages } = useQuery<{
    messages: Message[];
  }>({
    queryKey: ["messages", selectedId],
    queryFn: () => api.get(`/conversations/${selectedId}/messages`),
    enabled: !!selectedId,
  });

  // Send message mutation
  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      api.post(`/conversations/${selectedId}/messages`, { content, role: "user" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["messages", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["conversations"] });
      setMessageInput("");
    },
  });

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messagesData]);

  const conversations = convsData?.conversations || [];
  const messages = messagesData?.messages || [];
  const members = householdData?.members || [];
  const staff = staffData?.staff || [];
  const selectedConv = conversations.find((c) => c.id === selectedId);

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!messageInput.trim() || !selectedId) return;
    sendMutation.mutate(messageInput.trim());
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl h-[calc(100vh-48px)]">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" style={{ color: "#8a8070" }} />
          <h2
            className="text-[22px] font-normal"
            style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            Conversations
          </h2>
        </div>
        <p className="text-[13px] mt-1" style={{ color: "#7a7060" }}>
          {conversations.length} conversation{conversations.length !== 1 ? "s" : ""}
        </p>
      </div>

      {/* Main split view -- responsive: mobile shows one panel at a time */}
      <div className="flex gap-4 h-[calc(100%-80px)] min-h-[500px]">
        {/* Left: conversation list (hidden on mobile when a conversation is selected) */}
        <Card
          className={cn(
            "flex flex-col overflow-hidden border",
            selectedId ? "hidden md:flex" : "flex",
            "w-full md:w-80 md:shrink-0",
          )}
          style={{ borderColor: "#ddd5c8" }}
        >
          {/* Filters */}
          <div className="p-3 border-b space-y-2" style={{ borderColor: "#eee8dd" }}>
            <Select value={memberFilter} onValueChange={setMemberFilter}>
              <SelectTrigger className="h-8 text-xs" style={{ borderColor: "#ddd5c8" }}>
                <User className="h-3 w-3 mr-1.5" style={{ color: "#8a8070" }} />
                <SelectValue placeholder="All members" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All members</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={staffFilter} onValueChange={setStaffFilter}>
              <SelectTrigger className="h-8 text-xs" style={{ borderColor: "#ddd5c8" }}>
                <Bot className="h-3 w-3 mr-1.5" style={{ color: "#8a8070" }} />
                <SelectValue placeholder="All staff" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All staff</SelectItem>
                {staff.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Conversation list */}
          <div className="flex-1 overflow-y-auto">
            {loadingConvs && (
              <div className="p-4 space-y-3">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            )}
            {!loadingConvs && conversations.length === 0 && (
              <div className="flex flex-col items-center justify-center h-32 px-4 text-center">
                <MessageSquare className="h-5 w-5 mb-2" style={{ color: "#ddd5c8" }} />
                <p className="text-sm" style={{ color: "#8a8070" }}>No conversations yet.</p>
              </div>
            )}
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                isSelected={c.id === selectedId}
                onClick={() => setSelectedId(c.id)}
              />
            ))}
          </div>
        </Card>

        {/* Right: message thread (full-width on mobile when selected) */}
        <Card
          className={cn(
            "flex-1 flex flex-col overflow-hidden border",
            selectedId ? "flex" : "hidden md:flex",
          )}
          style={{ borderColor: "#ddd5c8" }}
        >
          {!selectedId ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
              <MessageSquare className="h-8 w-8 mb-3" style={{ color: "#ddd5c8" }} />
              <p className="text-sm" style={{ color: "#8a8070" }}>
                Select a conversation to view messages.
              </p>
            </div>
          ) : (
            <>
              {/* Thread header */}
              <div
                className="px-4 py-3 border-b flex items-center gap-3"
                style={{ borderColor: "#eee8dd" }}
              >
                <button
                  className="md:hidden shrink-0"
                  onClick={() => setSelectedId(null)}
                  aria-label="Back to conversations"
                >
                  <ArrowLeft className="h-4 w-4" style={{ color: "#8a8070" }} />
                </button>
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
                  style={{ background: "#f0ede6", color: "#8a8070" }}
                >
                  {selectedConv?.memberName?.charAt(0) || "?"}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: "#1a1f2e" }}>
                    {selectedConv?.memberName}
                  </p>
                  <p className="text-[11px]" style={{ color: "#8a8070" }}>
                    {selectedConv?.agentName || "Unknown agent"} &middot;{" "}
                    {selectedConv?.messageCount} message
                    {selectedConv?.messageCount !== 1 ? "s" : ""} &middot;{" "}
                    {selectedConv?.channel}
                  </p>
                </div>
              </div>

              {/* Messages */}
              <div className="flex-1 overflow-y-auto p-4">
                {loadingMessages && (
                  <div className="space-y-3">
                    <Skeleton className="h-10 w-3/5" />
                    <Skeleton className="h-10 w-2/5 ml-auto" />
                    <Skeleton className="h-10 w-3/5" />
                  </div>
                )}
                {!loadingMessages && messages.length === 0 && (
                  <div className="flex items-center justify-center h-32">
                    <p className="text-sm" style={{ color: "#8a8070" }}>
                      No messages in this conversation.
                    </p>
                  </div>
                )}
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <form
                onSubmit={handleSend}
                className="px-4 py-3 border-t flex gap-2"
                style={{ borderColor: "#eee8dd" }}
              >
                <Input
                  value={messageInput}
                  onChange={(e) => setMessageInput(e.target.value)}
                  placeholder="Type a message..."
                  className="flex-1 text-sm"
                  style={{ borderColor: "#ddd5c8" }}
                  disabled={sendMutation.isPending}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!messageInput.trim() || sendMutation.isPending}
                  style={{ background: "#1a1f2e", color: "#e8dfd0" }}
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
