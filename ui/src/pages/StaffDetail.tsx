import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  Save,
  Pause,
  Play,
  Pencil,
  MessageSquare,
  Shield,
  ListTodo,
  UserPlus,
  UserMinus,
  Users,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

interface Assignment {
  memberId: string;
  memberName: string;
  relationship: string;
}

interface StaffAgent {
  id: string;
  name: string;
  staffRole: string;
  specialty?: string;
  roleContent?: string;
  soulContent?: string;
  visibility?: string;
  telegramBotToken?: string;
  status: "active" | "paused" | "idle";
  isHeadButler?: boolean;
  autonomyLevel: string;
  assignments?: Assignment[];
}

interface Task {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  result?: string;
}

interface Conversation {
  id: string;
  memberId: string;
  memberName: string;
  lastMessage: string;
  lastMessageAt: string;
  messageCount: number;
}

interface PolicyEvent {
  id: string;
  clauseText: string;
  enforcementLevel: string;
  eventType: string;
  createdAt: string;
}

interface HouseholdMember {
  id: string;
  name: string;
  role: string;
}

interface HouseholdData {
  household: { id: string; name: string };
  members: HouseholdMember[];
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

const AUTONOMY_OPTIONS = [
  { value: "supervised", label: "Supervised" },
  { value: "trusted", label: "Trusted" },
  { value: "autonomous", label: "Autonomous" },
];

const TASK_STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  pending: { bg: "#fff3e0", text: "#8b6f4e" },
  approved: { bg: "#e8f5e9", text: "#2e7d32" },
  in_progress: { bg: "#e3f2fd", text: "#1565c0" },
  completed: { bg: "#e8f5e9", text: "#2e7d32" },
  failed: { bg: "#fce4ec", text: "#c62828" },
  cancelled: { bg: "#f5f5f5", text: "#757575" },
};

// ── Staff Detail Page ──────────────────────────────────────────────

export function StaffDetailPage() {
  const { staffId } = useParams();
  const queryClient = useQueryClient();

  const [soulDraft, setSoulDraft] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);

  // Fetch staff agent
  const { data: staffData, isLoading } = useQuery<{ agent: StaffAgent; assignments: Assignment[] }>({
    queryKey: ["staff", staffId],
    queryFn: () => api.get(`/staff/${staffId}`),
    enabled: !!staffId,
  });

  // Fetch household for assignment management + householdId
  const { data: householdData } = useQuery<HouseholdData>({
    queryKey: ["household"],
    queryFn: () => api.get("/households/current"),
    retry: false,
  });

  // Fetch tasks (needs householdId)
  const hid = householdData?.household?.id;
  const { data: tasksData } = useQuery<{ tasks: Task[] }>({
    queryKey: ["staff", staffId, "tasks", hid],
    queryFn: () => api.get(`/tasks?householdId=${hid}&agentId=${staffId}`),
    enabled: !!staffId && !!hid,
  });

  // Fetch conversations
  const { data: convsData } = useQuery<{ conversations: Conversation[] }>({
    queryKey: ["staff", staffId, "conversations"],
    queryFn: () => api.get(`/conversations?agentId=${staffId}`),
    enabled: !!staffId,
  });

  // Mutations
  const patchStaff = useMutation({
    mutationFn: (data: Partial<StaffAgent>) => api.put(`/staff/${staffId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff", staffId] });
      queryClient.invalidateQueries({ queryKey: ["staff"] });
    },
  });

  const addAssignment = useMutation({
    mutationFn: (data: { memberId: string; relationship: string }) =>
      api.post(`/staff/${staffId}/assignments`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff", staffId] });
    },
  });

  const removeAssignment = useMutation({
    mutationFn: (memberId: string) =>
      api.delete(`/staff/${staffId}/assignments/${memberId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff", staffId] });
    },
  });

  const rawAgent = staffData?.agent;
  const agent = rawAgent
    ? { ...rawAgent, assignments: rawAgent.assignments || staffData?.assignments }
    : undefined;
  const tasks = tasksData?.tasks || [];
  const conversations = convsData?.conversations || [];
  const allMembers = householdData?.members || [];

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl">
        <p className="text-sm" style={{ color: "#8a8070" }}>Loading staff agent...</p>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl">
        <Link
          to="/household"
          className="inline-flex items-center gap-1.5 text-sm mb-4"
          style={{ color: "#8a8070" }}
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Household
        </Link>
        <p className="text-sm" style={{ color: "#8a8070" }}>Staff agent not found.</p>
      </div>
    );
  }

  const currentSoul = soulDraft ?? agent.soulContent ?? "";
  const isButler = agent.isHeadButler || agent.staffRole === "head_butler";
  const roleLabel = isButler
    ? "Head Butler"
    : agent.staffRole.charAt(0).toUpperCase() + agent.staffRole.slice(1);

  const assignedMemberIds = new Set(agent.assignments?.map((a) => a.memberId) || []);
  const unassignedMembers = allMembers.filter((m) => !assignedMemberIds.has(m.id));

  const handleToggleStatus = () => {
    const newStatus = agent.status === "active" ? "paused" : "active";
    patchStaff.mutate({ status: newStatus } as Partial<StaffAgent>);
  };

  const handleSaveSoul = () => {
    if (soulDraft !== null) {
      patchStaff.mutate({ soulContent: soulDraft });
      setSoulDraft(null);
    }
  };

  const handleSaveRole = () => {
    if (roleDraft !== null) {
      patchStaff.mutate({ roleContent: roleDraft });
      setRoleDraft(null);
    }
  };

  const handleSaveName = () => {
    if (nameDraft && nameDraft.trim() && nameDraft !== agent.name) {
      patchStaff.mutate({ name: nameDraft.trim() });
    }
    setEditingName(false);
    setNameDraft(null);
  };

  const handleAutonomyChange = (level: string) => {
    patchStaff.mutate({ autonomyLevel: level } as Partial<StaffAgent>);
  };

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      {/* Back link */}
      <Link
        to="/household"
        className="inline-flex items-center gap-1.5 text-sm mb-4 hover:underline"
        style={{ color: "#8a8070" }}
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Household
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center text-xl font-semibold"
            style={{
              background: isButler ? "#f5f0e8" : "#f0ede6",
              color: "#8b6f4e",
              border: isButler ? "2px solid #8b6f4e" : "1.5px solid #ddd5c8",
            }}
          >
            {agent.name.charAt(0)}
          </div>
          <div>
            <div className="flex items-center gap-3">
              {editingName ? (
                <input
                  className="text-xl font-normal border-b-2 bg-transparent outline-none px-1"
                  style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif", borderColor: "#8b6f4e" }}
                  value={nameDraft ?? agent.name}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onBlur={handleSaveName}
                  onKeyDown={(e) => e.key === "Enter" && handleSaveName()}
                  autoFocus
                />
              ) : (
                <h2
                  className="text-xl font-normal cursor-pointer hover:opacity-70"
                  style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
                  onClick={() => { setEditingName(true); setNameDraft(agent.name); }}
                  title="Click to edit name"
                >
                  {agent.name}
                  <Pencil className="h-3 w-3 inline ml-2 opacity-40" />
                </h2>
              )}
              <Badge
                variant={agent.status === "active" ? "success" : agent.status === "paused" ? "warning" : "secondary"}
              >
                {agent.status}
              </Badge>
            </div>
            <p className="text-sm mt-0.5" style={{ color: "#8a8070" }}>
              {roleLabel}
              {agent.specialty ? ` \u00B7 ${agent.specialty}` : ""}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Select value={agent.autonomyLevel} onValueChange={handleAutonomyChange}>
            <SelectTrigger className="h-8 w-36 text-xs" style={{ borderColor: "#ddd5c8" }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTONOMY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleStatus}
            disabled={patchStaff.isPending}
            style={{ borderColor: "#ddd5c8" }}
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

      {/* Role editor */}
      <Card className="border mb-6" style={{ borderColor: "#ddd5c8" }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "#eee8dd" }}>
          <h3 className="text-sm font-semibold" style={{ color: "#1a1f2e" }}>
            Role / Job Description
          </h3>
          {roleDraft !== null && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveRole}
              disabled={patchStaff.isPending}
              style={{ borderColor: "#ddd5c8" }}
            >
              <Save className="h-3.5 w-3.5 mr-1" /> Save
            </Button>
          )}
        </div>
        <CardContent className="p-4">
          <Textarea
            value={roleDraft ?? agent.roleContent ?? ""}
            onChange={(e) => setRoleDraft(e.target.value)}
            placeholder="Define what this agent does: responsibilities, capabilities, tools it can use..."
            className="min-h-[100px] text-sm"
            style={{
              fontFamily: "ui-monospace, monospace",
              background: "#faf8f4",
              borderColor: "#ddd5c8",
            }}
          />
          <p className="text-xs mt-2" style={{ color: "#8a8070" }}>
            The role defines WHAT the agent does. This is compiled into the system prompt for every interaction.
          </p>
        </CardContent>
      </Card>

      {/* Soul editor */}
      <Card className="border mb-6" style={{ borderColor: "#ddd5c8" }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "#eee8dd" }}>
          <h3 className="text-sm font-semibold" style={{ color: "#1a1f2e" }}>
            Soul / Personality
          </h3>
          {soulDraft !== null && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveSoul}
              disabled={patchStaff.isPending}
              style={{ borderColor: "#ddd5c8" }}
            >
              <Save className="h-3.5 w-3.5 mr-1" /> Save
            </Button>
          )}
        </div>
        <CardContent className="p-4">
          <Textarea
            value={currentSoul}
            onChange={(e) => setSoulDraft(e.target.value)}
            placeholder="Define this agent's personality, tone, and behavioral guidelines..."
            className="min-h-[140px] text-sm"
            style={{
              fontFamily: "ui-monospace, monospace",
              background: "#faf8f4",
              borderColor: "#ddd5c8",
            }}
          />
        </CardContent>
      </Card>

      {/* Telegram Bot Token */}
      {agent.visibility !== "internal" && (
        <Card className="border mb-6" style={{ borderColor: "#ddd5c8" }}>
          <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "#eee8dd" }}>
            <h3 className="text-sm font-semibold" style={{ color: "#1a1f2e" }}>
              Telegram Bot
            </h3>
            {agent.telegramBotToken ? (
              <span className="text-xs px-2 py-0.5 rounded" style={{ background: "#e8f5e9", color: "#2e7d32" }}>
                Connected
              </span>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded" style={{ background: "#fff3e0", color: "#e65100" }}>
                Not configured
              </span>
            )}
          </div>
          <CardContent className="p-4 space-y-3">
            <div className="flex gap-2">
              <Input
                id="bot-token-input"
                type="text"
                placeholder="123456:ABC-DEF..."
                defaultValue={agent.telegramBotToken ?? ""}
                className="text-sm font-mono flex-1"
                style={{ background: "#faf8f4", borderColor: "#ddd5c8" }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <Button
                variant="outline"
                size="sm"
                style={{ borderColor: "#ddd5c8" }}
                disabled={patchStaff.isPending}
                onClick={() => {
                  const input = document.getElementById("bot-token-input") as HTMLInputElement;
                  const val = input?.value.trim() ?? "";
                  if (val !== (agent.telegramBotToken ?? "")) {
                    patchStaff.mutate({ telegramBotToken: val || null } as Partial<StaffAgent>);
                  }
                }}
              >
                <Save className="h-3.5 w-3.5 mr-1" /> Save
              </Button>
            </div>
            <div className="text-xs space-y-1" style={{ color: "#8a8070" }}>
              <p className="font-medium" style={{ color: "#5a5040" }}>Setup steps:</p>
              <ol className="list-decimal ml-4 space-y-0.5">
                <li>Open Telegram and message <span className="font-mono">@BotFather</span></li>
                <li>Send <span className="font-mono">/newbot</span> and follow the prompts</li>
                <li>Name it something like "{agent.name} Bot"</li>
                <li>Copy the token BotFather gives you and paste it above</li>
              </ol>
              <p className="mt-2">Each agent needs its own bot. The token connects this agent to Telegram so family members can message it directly.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Assignments */}
      <Card className="border mb-6" style={{ borderColor: "#ddd5c8" }}>
        <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "#eee8dd" }}>
          <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: "#1a1f2e" }}>
            <Users className="h-4 w-4" style={{ color: "#8a8070" }} />
            Assignments
          </h3>
        </div>
        <CardContent className="p-4">
          {/* Current assignments */}
          {agent.assignments && agent.assignments.length > 0 ? (
            <div className="space-y-2 mb-3">
              {agent.assignments.map((a) => (
                <div
                  key={a.memberId}
                  className="flex items-center justify-between py-2 px-3 rounded"
                  style={{ background: "#faf8f4" }}
                >
                  <div>
                    <span className="text-sm font-medium" style={{ color: "#1a1f2e" }}>
                      {a.memberName}
                    </span>
                    <span className="text-xs ml-2" style={{ color: "#8a8070" }}>
                      {a.relationship}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-red-500 hover:text-red-600"
                    onClick={() => removeAssignment.mutate(a.memberId)}
                    disabled={removeAssignment.isPending}
                  >
                    <UserMinus className="h-3 w-3 mr-1" /> Remove
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm mb-3" style={{ color: "#8a8070" }}>
              No members assigned to this agent.
            </p>
          )}

          {/* Add assignment */}
          {unassignedMembers.length > 0 && (
            <div className="flex gap-2 items-center pt-2 border-t" style={{ borderColor: "#eee8dd" }}>
              <Select
                onValueChange={(memberId) =>
                  addAssignment.mutate({ memberId, relationship: "primary" })
                }
              >
                <SelectTrigger className="h-8 w-48 text-xs" style={{ borderColor: "#ddd5c8" }}>
                  <SelectValue placeholder="Assign a member..." />
                </SelectTrigger>
                <SelectContent>
                  {unassignedMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[10px]" style={{ color: "#a09080" }}>
                as primary assignment
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delegation edges */}
      {agent.staffRole === "personal" || agent.staffRole === "head_butler" ? (
        <DelegationEdgesCard agentId={agent.id} agentName={agent.name} />
      ) : null}

      {/* Task history */}
      <Card className="border mb-6" style={{ borderColor: "#ddd5c8" }}>
        <div className="px-4 py-3 border-b" style={{ borderColor: "#eee8dd" }}>
          <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: "#1a1f2e" }}>
            <ListTodo className="h-4 w-4" style={{ color: "#8a8070" }} />
            Recent Tasks
          </h3>
        </div>
        <div>
          {tasks.length === 0 && (
            <p className="text-sm p-4" style={{ color: "#8a8070" }}>Tasks appear when this agent processes requests.</p>
          )}
          {tasks.map((task) => {
            const style = TASK_STATUS_STYLES[task.status] || TASK_STATUS_STYLES.pending;
            return (
              <Link
                key={task.id}
                to="/tasks"
                className="flex items-center gap-3 px-4 py-2.5 border-b last:border-0 hover:bg-[#faf8f4] transition-colors"
                style={{ borderColor: "#eee8dd" }}
              >
                <span
                  className="text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase whitespace-nowrap"
                  style={{ background: style.bg, color: style.text }}
                >
                  {task.status.replace(/_/g, " ")}
                </span>
                <span className="text-sm flex-1 truncate" style={{ color: "#2c2c2c" }}>
                  {task.title}
                </span>
                <span className="text-xs shrink-0" style={{ color: "#a09080" }}>
                  {relativeTime(task.createdAt)}
                </span>
              </Link>
            );
          })}
        </div>
      </Card>

      {/* Recent conversations */}
      <Card className="border mb-6" style={{ borderColor: "#ddd5c8" }}>
        <div className="px-4 py-3 border-b" style={{ borderColor: "#eee8dd" }}>
          <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: "#1a1f2e" }}>
            <MessageSquare className="h-4 w-4" style={{ color: "#8a8070" }} />
            Recent Conversations
          </h3>
        </div>
        <div>
          {conversations.length === 0 && (
            <p className="text-sm p-4" style={{ color: "#8a8070" }}>No conversations yet.</p>
          )}
          {conversations.slice(0, 5).map((c) => (
            <Link
              key={c.id}
              to="/conversations"
              className="flex items-center gap-3 px-4 py-2.5 border-b last:border-0 hover:bg-[#faf8f4] transition-colors"
              style={{ borderColor: "#eee8dd" }}
            >
              <div
                className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold shrink-0"
                style={{ background: "#f0ede6", color: "#8a8070" }}
              >
                {c.memberName.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium" style={{ color: "#1a1f2e" }}>
                  {c.memberName}
                </span>
                <p className="text-xs truncate" style={{ color: "#8a8070" }}>
                  {c.lastMessage}
                </p>
              </div>
              <div className="text-right shrink-0">
                <span className="text-xs" style={{ color: "#a09080" }}>
                  {c.messageCount} msg{c.messageCount !== 1 ? "s" : ""}
                </span>
                <p className="text-[10px]" style={{ color: "#a09080" }}>
                  {relativeTime(c.lastMessageAt)}
                </p>
              </div>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ── Delegation Edges Card ─────────────────────────────────────────

function DelegationEdgesCard({ agentId, agentName }: { agentId: string; agentName: string }) {
  const queryClient = useQueryClient();

  // Load current delegation edges
  const { data: edgesData } = useQuery<{ delegations: Array<{ id: string; toAgentId: string; toAgentName: string; toAgentRole: string }> }>({
    queryKey: ["delegations", agentId],
    queryFn: () => api.get(`/staff/${agentId}/delegations`),
  });

  // Load all internal agents as candidates
  const { data: staffData } = useQuery<{ staff: Array<{ id: string; name: string; staffRole: string; visibility: string }> }>({
    queryKey: ["staff"],
    queryFn: () => api.get("/staff"),
  });

  const addEdge = useMutation({
    mutationFn: (toAgentId: string) => api.post(`/staff/${agentId}/delegations`, { toAgentId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["delegations", agentId] }),
  });

  const removeEdge = useMutation({
    mutationFn: (toAgentId: string) => api.delete(`/staff/${agentId}/delegations/${toAgentId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["delegations", agentId] }),
  });

  const edges = edgesData?.delegations || [];
  const edgeTargetIds = new Set(edges.map((e) => e.toAgentId));
  const internalAgents = (staffData?.staff || []).filter(
    (a) => a.visibility === "internal" && a.id !== agentId,
  );

  // If no internal agents exist, show guidance
  const allAgents = staffData?.staff || [];
  const hasInternalAgents = internalAgents.length > 0;

  const toggleEdge = (targetId: string) => {
    if (edgeTargetIds.has(targetId)) {
      removeEdge.mutate(targetId);
    } else {
      addEdge.mutate(targetId);
    }
  };

  return (
    <Card className="border mb-6" style={{ borderColor: "#ddd5c8" }}>
      <div className="px-4 py-3 border-b" style={{ borderColor: "#eee8dd" }}>
        <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: "#1a1f2e" }}>
          <Shield className="h-4 w-4" style={{ color: "#8a8070" }} />
          Delegation
        </h3>
      </div>
      <CardContent className="p-4">
        {!hasInternalAgents ? (
          <p className="text-sm" style={{ color: "#8a8070" }}>
            No internal agents available. Create internal specialist agents (tutor, coach, scheduler) from the{" "}
            <Link to="/household" className="underline" style={{ color: "#8b6f4e" }}>Household page</Link>{" "}
            to enable delegation.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs mb-3" style={{ color: "#8a8070" }}>
              {agentName} can delegate work to these internal specialists:
            </p>
            {internalAgents.map((a) => (
              <label
                key={a.id}
                className="flex items-center gap-3 py-2 px-3 rounded cursor-pointer hover:opacity-80"
                style={{ background: edgeTargetIds.has(a.id) ? "#f0ede6" : "transparent" }}
              >
                <input
                  type="checkbox"
                  checked={edgeTargetIds.has(a.id)}
                  onChange={() => toggleEdge(a.id)}
                  disabled={addEdge.isPending || removeEdge.isPending}
                  className="rounded"
                  style={{ accentColor: "#8b6f4e" }}
                />
                <div>
                  <span className="text-sm font-medium" style={{ color: "#1a1f2e" }}>
                    {a.name}
                  </span>
                  <span className="text-xs ml-2" style={{ color: "#8a8070" }}>
                    {a.staffRole}
                  </span>
                </div>
              </label>
            ))}
          </div>
        )}

        {/* Also show any edges to non-internal agents (family-visible specialists) */}
        {allAgents.filter((a) => a.visibility !== "internal" && a.id !== agentId).length > 0 && hasInternalAgents && (
          <div className="mt-3 pt-3 border-t" style={{ borderColor: "#eee8dd" }}>
            <p className="text-xs mb-2" style={{ color: "#a09080" }}>
              Family-visible agents (optional):
            </p>
            {allAgents
              .filter((a) => a.visibility !== "internal" && a.id !== agentId)
              .map((a) => (
                <label
                  key={a.id}
                  className="flex items-center gap-3 py-1.5 px-3 rounded cursor-pointer hover:opacity-80"
                >
                  <input
                    type="checkbox"
                    checked={edgeTargetIds.has(a.id)}
                    onChange={() => toggleEdge(a.id)}
                    disabled={addEdge.isPending || removeEdge.isPending}
                    className="rounded"
                    style={{ accentColor: "#8b6f4e" }}
                  />
                  <span className="text-xs" style={{ color: "#8a8070" }}>
                    {a.name} ({a.staffRole})
                  </span>
                </label>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
