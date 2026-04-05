import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { MessageSquare, User } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// --- Types ---

interface FamilyData {
  family: { id: string; name: string };
  members: Member[];
}

interface Member {
  id: string;
  name: string;
  role: string;
  age: number;
}

interface Conversation {
  id: string;
  agentId: string;
  memberId: string;
  memberName: string;
  lastMessage: string;
  lastMessageAt: string;
  messageCount: number;
}

interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  policyEvent?: {
    id: string;
    ruleText: string;
    enforcementLevel: string;
  } | null;
}

// --- Helpers ---

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

// --- Sub-components ---

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
        "w-full text-left px-4 py-3 border-b border-border/50 hover:bg-accent/50 transition-colors",
        isSelected && "bg-accent",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center text-xs font-semibold text-muted-foreground shrink-0">
          {conversation.memberName.charAt(0)}
        </div>
        <span className="font-medium text-sm truncate">
          {conversation.memberName}
        </span>
        <span className="text-[11px] text-muted-foreground ml-auto shrink-0">
          {relativeTime(conversation.lastMessageAt)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground truncate pl-9">
        {conversation.lastMessage}
      </p>
    </button>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex mb-3", isUser ? "justify-end" : "justify-start")}>
      <div className="max-w-[75%]">
        <div
          className={cn(
            "rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
            isUser
              ? "bg-foreground text-background"
              : "bg-secondary text-foreground",
          )}
        >
          {message.content}
        </div>
        <div
          className={cn(
            "flex items-center gap-2 mt-1",
            isUser ? "justify-end" : "justify-start",
          )}
        >
          <span className="text-[10px] text-muted-foreground">
            {formatTime(message.createdAt)}
          </span>
          {message.policyEvent && (
            <Badge
              variant={
                message.policyEvent.enforcementLevel === "hard"
                  ? "destructive"
                  : "warning"
              }
              className="text-[10px]"
            >
              {message.policyEvent.enforcementLevel === "hard"
                ? "blocked"
                : "flagged"}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Page ---

export function ConversationsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [memberFilter, setMemberFilter] = useState<string>("all");

  const { data: familyData } = useQuery<FamilyData>({
    queryKey: ["family"],
    queryFn: () => api.get("/families/current"),
    retry: false,
  });

  const familyId = familyData?.family?.id;

  const { data: conversationsData, isLoading: loadingConversations } =
    useQuery<{ conversations: Conversation[] }>({
      queryKey: ["conversations", familyId, memberFilter],
      queryFn: () => {
        const params =
          memberFilter !== "all" ? `?memberId=${memberFilter}` : "";
        return api.get(`/families/${familyId}/conversations${params}`);
      },
      enabled: !!familyId,
    });

  const { data: messagesData, isLoading: loadingMessages } = useQuery<{
    messages: Message[];
  }>({
    queryKey: ["messages", selectedId],
    queryFn: () => api.get(`/conversations/${selectedId}/messages`),
    enabled: !!selectedId,
  });

  const conversations = conversationsData?.conversations || [];
  const messages = messagesData?.messages || [];
  const members = familyData?.members || [];
  const selectedConversation = conversations.find((c) => c.id === selectedId);

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Conversations</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {conversations.length} conversation{conversations.length !== 1 && "s"}{" "}
          across all agents
        </p>
      </div>

      <div className="flex gap-4 h-[calc(100vh-180px)] min-h-[500px]">
        {/* Sidebar */}
        <Card className="w-80 shrink-0 flex flex-col overflow-hidden">
          <div className="p-3 border-b space-y-2">
            <Select value={memberFilter} onValueChange={setMemberFilter}>
              <SelectTrigger className="h-8 text-xs">
                <User className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                <SelectValue placeholder="All members" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All members</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loadingConversations && (
              <div className="flex items-center justify-center h-32">
                <p className="text-sm text-muted-foreground">Loading...</p>
              </div>
            )}
            {!loadingConversations && conversations.length === 0 && (
              <div className="flex flex-col items-center justify-center h-32 px-4 text-center">
                <MessageSquare className="h-5 w-5 text-muted-foreground/50 mb-2" />
                <p className="text-sm text-muted-foreground">
                  No conversations yet.
                </p>
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

        {/* Message panel */}
        <Card className="flex-1 flex flex-col overflow-hidden">
          {!selectedId ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
              <MessageSquare className="h-8 w-8 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">
                Select a conversation to view messages.
              </p>
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold text-muted-foreground">
                  {selectedConversation?.memberName?.charAt(0) || "?"}
                </div>
                <div>
                  <p className="text-sm font-medium">
                    {selectedConversation?.memberName}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {selectedConversation?.messageCount} message
                    {selectedConversation?.messageCount !== 1 && "s"}
                  </p>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {loadingMessages && (
                  <div className="flex items-center justify-center h-32">
                    <p className="text-sm text-muted-foreground">Loading...</p>
                  </div>
                )}
                {!loadingMessages && messages.length === 0 && (
                  <div className="flex items-center justify-center h-32">
                    <p className="text-sm text-muted-foreground">
                      No messages in this conversation.
                    </p>
                  </div>
                )}
                {messages.map((m) => (
                  <MessageBubble key={m.id} message={m} />
                ))}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
