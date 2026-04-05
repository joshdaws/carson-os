import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pause,
  Play,
  Save,
  MessageSquare,
  Shield,
  ArrowLeft,
  DollarSign,
} from "lucide-react";

// --- Types ---

interface AgentMember {
  id: string;
  name: string;
  role: string;
  age: number;
}

interface Agent {
  id: string;
  memberId: string;
  status: "active" | "paused" | "idle";
  model: string;
  soul: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  member: AgentMember;
}

interface AgentConversation {
  id: string;
  lastMessage: string;
  lastMessageAt: string;
  messageCount: number;
}

interface PolicyEvent {
  id: string;
  ruleText: string;
  enforcementLevel: string;
  action: string;
  createdAt: string;
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

const statusVariant: Record<string, "success" | "warning" | "secondary"> = {
  active: "success",
  paused: "warning",
  idle: "secondary",
};

const MODEL_OPTIONS = [
  { value: "claude-sonnet-4-20250514", label: "Sonnet" },
  { value: "claude-haiku-35-20241022", label: "Haiku" },
  { value: "claude-opus-4-20250514", label: "Opus" },
];

// --- Page ---

export function AgentDetailPage() {
  const { agentId } = useParams();
  const queryClient = useQueryClient();

  const [soulDraft, setSoulDraft] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null);

  // Fetch agent
  const { data: agentData, isLoading } = useQuery<{ agent: Agent }>({
    queryKey: ["agent", agentId],
    queryFn: () => api.get(`/agents/${agentId}`),
    enabled: !!agentId,
  });

  // Fetch conversations
  const { data: convsData } = useQuery<{
    conversations: AgentConversation[];
  }>({
    queryKey: ["agent", agentId, "conversations"],
    queryFn: () => api.get(`/agents/${agentId}/conversations`),
    enabled: !!agentId,
  });

  // Fetch policy events
  const { data: eventsData } = useQuery<{ events: PolicyEvent[] }>({
    queryKey: ["agent", agentId, "policy-events"],
    queryFn: () => api.get(`/agents/${agentId}/policy-events`),
    enabled: !!agentId,
  });

  // Mutations
  const patchAgent = useMutation({
    mutationFn: (data: Partial<Agent>) =>
      api.patch(`/agents/${agentId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
    },
  });

  const agent = agentData?.agent;
  const conversations = convsData?.conversations?.slice(0, 5) || [];
  const events = eventsData?.events?.slice(0, 10) || [];

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl">
        <p className="text-sm text-muted-foreground">Loading agent...</p>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-6 max-w-4xl">
        <p className="text-sm text-muted-foreground">Agent not found.</p>
      </div>
    );
  }

  const budgetPct = Math.round(
    (agent.spentMonthlyCents / Math.max(agent.budgetMonthlyCents, 1)) * 100,
  );
  const spentDollars = (agent.spentMonthlyCents / 100).toFixed(2);
  const budgetDollars = (agent.budgetMonthlyCents / 100).toFixed(2);
  const currentSoul = soulDraft ?? agent.soul ?? "";
  const currentBudgetStr =
    budgetDraft ?? (agent.budgetMonthlyCents / 100).toFixed(0);
  const roleLabel =
    agent.member.role === "parent"
      ? "Parent"
      : agent.member.role === "student"
        ? `Student, ${agent.member.age}`
        : `Child, ${agent.member.age}`;

  const handleToggleStatus = () => {
    const newStatus = agent.status === "active" ? "paused" : "active";
    patchAgent.mutate({ status: newStatus } as Partial<Agent>);
  };

  const handleSaveSoul = () => {
    if (soulDraft !== null) {
      patchAgent.mutate({ soul: soulDraft } as Partial<Agent>);
      setSoulDraft(null);
    }
  };

  const handleSaveBudget = () => {
    if (budgetDraft !== null) {
      const cents = Math.round(parseFloat(budgetDraft) * 100);
      if (!isNaN(cents) && cents >= 0) {
        patchAgent.mutate({
          budgetMonthlyCents: cents,
        } as Partial<Agent>);
        setBudgetDraft(null);
      }
    }
  };

  const handleModelChange = (model: string) => {
    patchAgent.mutate({ model } as Partial<Agent>);
  };

  return (
    <div className="p-6 max-w-4xl">
      {/* Back link */}
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Dashboard
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center text-lg font-semibold text-muted-foreground">
            {agent.member.name.charAt(0)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">{agent.member.name}</h2>
              <Badge variant={statusVariant[agent.status] || "secondary"}>
                {agent.status}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">{roleLabel}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select value={agent.model} onValueChange={handleModelChange}>
            <SelectTrigger className="h-8 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODEL_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant={agent.status === "active" ? "outline" : "default"}
            size="sm"
            onClick={handleToggleStatus}
            disabled={patchAgent.isPending}
          >
            {agent.status === "active" ? (
              <>
                <Pause className="h-3.5 w-3.5 mr-1" /> Pause
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 mr-1" /> Resume
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        {/* Budget card */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between mb-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Budget
              </p>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-2xl font-bold">${spentDollars}</p>
            <p className="text-xs text-muted-foreground mt-1">
              of ${budgetDollars} monthly cap ({budgetPct}%)
            </p>
            <Progress
              value={budgetPct}
              max={100}
              className={cn(
                "mt-3",
                budgetPct > 80 && "[&>div]:bg-red-500",
                budgetPct > 50 && budgetPct <= 80 && "[&>div]:bg-yellow-500",
              )}
            />
            <div className="flex items-center gap-2 mt-3">
              <Input
                type="number"
                value={currentBudgetStr}
                onChange={(e) => setBudgetDraft(e.target.value)}
                className="h-8 text-xs w-24"
                min={0}
                step={1}
              />
              <span className="text-xs text-muted-foreground">/mo</span>
              {budgetDraft !== null && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSaveBudget}
                  disabled={patchAgent.isPending}
                  className="h-7 text-xs"
                >
                  Save
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Conversations stat */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between mb-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Conversations
              </p>
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-2xl font-bold">{conversations.length}</p>
            <p className="text-xs text-muted-foreground mt-1">recent threads</p>
          </CardContent>
        </Card>

        {/* Policy events stat */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-start justify-between mb-3">
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Policy Events
              </p>
              <Shield className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-2xl font-bold">{events.length}</p>
            <p className="text-xs text-muted-foreground mt-1">recent events</p>
          </CardContent>
        </Card>
      </div>

      {/* Soul editor */}
      <Card className="mb-6">
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold">Soul / Personality</h3>
          {soulDraft !== null && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveSoul}
              disabled={patchAgent.isPending}
            >
              <Save className="h-3.5 w-3.5 mr-1" /> Save
            </Button>
          )}
        </div>
        <CardContent className="p-4 pt-4">
          <Textarea
            value={currentSoul}
            onChange={(e) => setSoulDraft(e.target.value)}
            placeholder="Define this agent's personality, tone, and behavioral guidelines..."
            className="min-h-[160px] text-sm font-mono"
          />
        </CardContent>
      </Card>

      {/* Recent conversations */}
      <Card className="mb-6">
        <div className="px-4 py-3 border-b">
          <h3 className="text-sm font-semibold">Recent Conversations</h3>
        </div>
        <div>
          {conversations.length === 0 && (
            <p className="text-sm text-muted-foreground p-4">
              No conversations yet.
            </p>
          )}
          {conversations.map((c) => (
            <Link
              key={c.id}
              to="/conversations"
              className="flex items-center gap-3 px-4 py-2.5 border-b border-border/50 last:border-0 hover:bg-accent/50 transition-colors"
            >
              <MessageSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-sm truncate flex-1">{c.lastMessage}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                {c.messageCount} msg{c.messageCount !== 1 && "s"}
              </span>
              <span className="text-[11px] text-muted-foreground shrink-0">
                {relativeTime(c.lastMessageAt)}
              </span>
            </Link>
          ))}
        </div>
      </Card>

      {/* Policy events */}
      <Card>
        <div className="px-4 py-3 border-b">
          <h3 className="text-sm font-semibold">Policy Events</h3>
        </div>
        <div>
          {events.length === 0 && (
            <p className="text-sm text-muted-foreground p-4">
              No policy events.
            </p>
          )}
          {events.map((e) => (
            <div
              key={e.id}
              className="flex items-start gap-3 px-4 py-2.5 border-b border-border/50 last:border-0 text-sm"
            >
              <span className="text-xs text-muted-foreground min-w-[48px] pt-0.5">
                {relativeTime(e.createdAt)}
              </span>
              <div className="flex-1">
                <span className="text-muted-foreground">{e.ruleText}</span>
                <Badge
                  variant={
                    e.enforcementLevel === "hard" ? "destructive" : "warning"
                  }
                  className="ml-2 text-[10px]"
                >
                  {e.action}
                </Badge>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
