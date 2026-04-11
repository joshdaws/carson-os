import { useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { SkeletonCard } from "@/components/ui/skeleton";
import {
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
  Users,
  UserCog,
  Shield,
  FileUser,
} from "lucide-react";
import { Link } from "react-router-dom";
import { InterviewOverlay } from "@/components/InterviewOverlay";
import type { ChatMessage } from "@/components/ChatBubble";
import { useToast } from "@/components/Toast";

// ── Types ──────────────────────────────────────────────────────────

type MemberRole = "parent" | "kid";
type StaffRole = "head_butler" | "personal" | "tutor" | "coach" | "scheduler" | "custom";
type AgentStatus = "active" | "paused" | "idle";
type TrustLevel = "full" | "standard" | "restricted";

interface Assignment {
  memberId: string;
  memberName: string;
  relationship: string;
}

interface StaffAgent {
  id: string;
  name: string;
  staffRole: StaffRole;
  specialty?: string;
  status: AgentStatus;
  isHeadButler?: boolean;
  trustLevel?: string;
  model?: string;
  assignments?: Assignment[];
}

interface HouseholdMember {
  id: string;
  name: string;
  role: MemberRole;
  age?: number;
  telegramUserId?: string | null;
  profileContent?: string | null;
  profileUpdatedAt?: string | null;
}

interface HouseholdData {
  household: { id: string; name: string };
  members: HouseholdMember[];
}

// ── Constants ──────────────────────────────────────────────────────

const ROLE_OPTIONS: { value: MemberRole; label: string }[] = [
  { value: "parent", label: "Parent" },
  { value: "kid", label: "Kid" },
];

const STAFF_ROLE_OPTIONS: { value: StaffRole; label: string }[] = [
  { value: "personal", label: "Personal Agent" },
  { value: "head_butler", label: "Chief of Staff" },
  { value: "tutor", label: "Tutor" },
  { value: "coach", label: "Coach" },
  { value: "scheduler", label: "Scheduler" },
  { value: "custom", label: "Custom" },
];

const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-opus-4-6": "Opus 4.6",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
  "claude-haiku-4-5": "Haiku 4.5",
};

const TRUST_LEVEL_OPTIONS: { value: TrustLevel; label: string; description: string }[] = [
  { value: "full", label: "Full", description: "Bash, files, web, skills" },
  { value: "standard", label: "Standard", description: "Read-only file access" },
  { value: "restricted", label: "Restricted", description: "Memory tools only" },
];

const MODEL_OPTIONS = [
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

function statusColor(s: AgentStatus): string {
  if (s === "active") return "bg-[#4a7c59]";
  if (s === "paused") return "bg-[#b8860b]";
  return "bg-[#8a8070]";
}

function roleLabel(r: StaffRole): string {
  return r === "head_butler" ? "Chief of Staff" : r.charAt(0).toUpperCase() + r.slice(1);
}

// ── Add Member Form ────────────────────────────────────────────────

function AddMemberForm({
  householdId,
  onClose,
}: {
  householdId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [role, setRole] = useState<MemberRole>("kid");
  const [age, setAge] = useState("");
  const [telegramUserId, setTelegramUserId] = useState("");

  const mutation = useMutation({
    mutationFn: (payload: { name: string; role: MemberRole; age: number; telegramUserId?: string }) =>
      api.post(`/households/${householdId}/members`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["household"] });
      toast.success("Member added");
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!name.trim() || !age) return;
    mutation.mutate({
      name: name.trim(),
      role,
      age: parseInt(age, 10),
      ...(telegramUserId.trim() ? { telegramUserId: telegramUserId.trim() } : {}),
    });
  }

  const nameError = submitted && !name.trim();
  const ageError = submitted && !age;

  return (
    <Card className="border" style={{ borderColor: "#ddd5c8" }}>
      <CardContent className="p-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium" style={{ color: "#1a1f2e" }}>
              New Member
            </span>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Input
                placeholder="Name *"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                style={nameError ? { borderColor: "#c62828" } : undefined}
              />
              {nameError && <p className="text-[10px] mt-1" style={{ color: "#c62828" }}>Name is required</p>}
            </div>
            <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Input
                type="number"
                placeholder="Age *"
                min={1}
                max={99}
                value={age}
                onChange={(e) => setAge(e.target.value)}
                style={ageError ? { borderColor: "#c62828" } : undefined}
              />
              {ageError && <p className="text-[10px] mt-1" style={{ color: "#c62828" }}>Age is required</p>}
            </div>
            <Input placeholder="Telegram ID (optional)" value={telegramUserId} onChange={(e) => setTelegramUserId(e.target.value)} />
          </div>
          <div className="flex items-center justify-end pt-1">
            <Button type="submit" size="sm" disabled={mutation.isPending}>
              {mutation.isPending ? "Adding..." : "Add Member"}
            </Button>
          </div>
          {mutation.isError && (
            <p className="text-xs text-red-600">{(mutation.error as Error).message}</p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ── Edit Member Form ───────────────────────────────────────────────

function EditMemberForm({
  member,
  householdId,
  staffAssignments,
  onClose,
}: {
  member: HouseholdMember;
  householdId: string;
  staffAssignments: { staffName: string; staffRole: string }[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(member.name);
  const [role, setRole] = useState<MemberRole>(member.role);
  const [age, setAge] = useState(String(member.age || ""));
  const [telegramUserId, setTelegramUserId] = useState(member.telegramUserId || "");

  const updateMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.put(`/households/${householdId}/members/${member.id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["household"] });
      toast.success("Member updated");
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/households/${householdId}/members/${member.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["household"] });
      toast.success("Member removed");
      onClose();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleSave() {
    const payload: Record<string, unknown> = {};
    if (name.trim() !== member.name) payload.name = name.trim();
    if (role !== member.role) payload.role = role;
    if (age && parseInt(age, 10) !== member.age) payload.age = parseInt(age, 10);
    const tg = telegramUserId.trim() || null;
    if (tg !== (member.telegramUserId || null)) payload.telegramUserId = tg;
    if (Object.keys(payload).length === 0) { onClose(); return; }
    updateMutation.mutate(payload);
  }

  return (
    <Card className="border-2" style={{ borderColor: "#8b6f4e" }}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium" style={{ color: "#1a1f2e" }}>Edit Member</span>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleSave} disabled={updateMutation.isPending}>
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Input type="number" placeholder="Age" min={1} max={99} value={age} onChange={(e) => setAge(e.target.value)} />
          <Input placeholder="Telegram ID" value={telegramUserId} onChange={(e) => setTelegramUserId(e.target.value)} />
        </div>
        {staffAssignments.length > 0 && (
          <div className="pt-2 border-t" style={{ borderColor: "#eee8dd" }}>
            <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "#8a8070" }}>
              Assigned Staff
            </p>
            <div className="flex flex-wrap gap-1.5">
              {staffAssignments.map((sa, i) => (
                <Badge key={i} variant="secondary" className="text-[10px]">
                  {sa.staffName} ({sa.staffRole})
                </Badge>
              ))}
            </div>
          </div>
        )}
        <div className="flex justify-end pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-red-600 hover:text-red-700 hover:bg-red-50 text-xs"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="h-3 w-3 mr-1" /> Remove
          </Button>
        </div>
        {(updateMutation.isError || deleteMutation.isError) && (
          <p className="text-xs text-red-600">
            {((updateMutation.error || deleteMutation.error) as Error)?.message}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Member Card ────────────────────────────────────────────────────

function MemberCard({
  member,
  householdId,
  staffAssignments,
  onStartInterview,
}: {
  member: HouseholdMember;
  householdId: string;
  staffAssignments: { staffName: string; staffRole: string }[];
  onStartInterview: (memberId: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditMemberForm
        member={member}
        householdId={householdId}
        staffAssignments={staffAssignments}
        onClose={() => setEditing(false)}
      />
    );
  }

  const hasProfile = !!member.profileContent;

  return (
    <Card className="border hover:shadow-sm transition-shadow" style={{ borderColor: "#ddd5c8" }}>
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold"
            style={{ background: "#f0ede6", color: "#8a8070" }}
          >
            {member.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <span className="font-medium text-sm" style={{ color: "#1a1f2e" }}>
              {member.name}
            </span>
            <p className="text-xs" style={{ color: "#8a8070" }}>
              {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
              {member.age ? ` (${member.age})` : ""}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setEditing(true)}>
            <Pencil className="h-3.5 w-3.5" style={{ color: "#8a8070" }} />
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs mb-2">
          {member.telegramUserId && (
            <span style={{ color: "#8a8070" }}>TG: {member.telegramUserId}</span>
          )}
          {staffAssignments.length > 0 && (
            <span style={{ color: "#a09080" }}>
              Staff: {staffAssignments.map((s) => s.staffName).join(", ")}
            </span>
          )}
        </div>
        {/* Profile status + interview button */}
        <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: "#eee8dd" }}>
          <div className="flex items-center gap-1.5">
            <FileUser className="h-3.5 w-3.5" style={{ color: hasProfile ? "#2e7d32" : "#ddd5c8" }} />
            <span className="text-[11px]" style={{ color: hasProfile ? "#2e7d32" : "#a09080" }}>
              {hasProfile ? "Profile set" : "No profile"}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            style={{ color: "#8b6f4e" }}
            onClick={() => onStartInterview(member.id)}
          >
            <FileUser className="h-3 w-3 mr-1" />
            {hasProfile ? "Re-interview" : "Build Profile"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Add Staff Form ─────────────────────────────────────────────────

// Role templates pre-fill roleContent based on agent type
const ROLE_TEMPLATES: Record<string, string> = {
  personal: "You are {name}'s personal assistant. You help with homework, schedule management, activity planning, and general questions. You delegate specialized work to internal specialists when appropriate. You always respond in a way that matches {name}'s age and communication style.",
  tutor: "You create study plans, generate practice questions, review essays, build vocabulary lists, and track learning progress. You coach through problems without giving direct answers unless the constitution allows it.",
  coach: "You build workout schedules, create practice plans, track fitness goals, suggest activities, and encourage physical activity.",
  scheduler: "You manage calendar events, find free time, coordinate family schedules, propose time blocks, and send reminders.",
  head_butler: "You oversee all staff, coordinate family schedules, and ensure the family constitution is upheld. You're the family's primary point of contact.",
  custom: "",
};

function AddStaffModal({
  householdId,
  members,
  onClose,
}: {
  householdId: string;
  members: HouseholdMember[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [staffRole, setStaffRole] = useState<StaffRole>("personal");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [trustLevel, setTrustLevel] = useState<TrustLevel>("restricted");
  const [assignTo, setAssignTo] = useState<string>("");
  const [botToken, setBotToken] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post("/staff", payload) as Promise<{ agent: { id: string } }>,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["staff"] });
      navigate(`/staff/${data.agent.id}`);
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!name.trim()) return;

    const template = ROLE_TEMPLATES[staffRole] || "";
    const roleContent = template.replace(/\{name\}/g, assignTo ? (members.find((m) => m.id === assignTo)?.name ?? name.trim()) : name.trim());

    mutation.mutate({
      householdId,
      name: name.trim(),
      staffRole,
      roleContent,
      model,
      trustLevel,
      visibility: "family",
      ...(botToken.trim() ? { telegramBotToken: botToken.trim() } : {}),
    });
  }

  const nameError = submitted && !name.trim();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-lg shadow-xl w-full max-w-md mx-4"
        style={{ background: "#faf6ef", border: "1px solid #ddd5c8" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "#eee8dd" }}>
          <h3 className="text-base font-medium" style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}>
            New Staff Agent
          </h3>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {/* Name */}
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Name</label>
            <Input
              placeholder="e.g., Django"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              style={nameError ? { borderColor: "#c62828" } : undefined}
            />
            {nameError && <p className="text-[10px] mt-1" style={{ color: "#c62828" }}>Name is required</p>}
          </div>

          {/* Role + Assign to */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Role</label>
              <Select value={staffRole} onValueChange={(v) => setStaffRole(v as StaffRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STAFF_ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Assign to</label>
              <Select value={assignTo} onValueChange={setAssignTo}>
                <SelectTrigger><SelectValue placeholder="Select member..." /></SelectTrigger>
                <SelectContent>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name} ({m.role})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Model + Trust Level */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Model</label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Trust Level</label>
              <Select value={trustLevel} onValueChange={(v) => setTrustLevel(v as TrustLevel)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TRUST_LEVEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                      <span className="text-[10px] ml-1.5" style={{ color: "#8a8070" }}>{o.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Telegram Bot Token */}
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>
              Telegram Bot Token <span style={{ color: "#a09080" }}>(optional)</span>
            </label>
            <Input
              type="password"
              placeholder="123456:ABC-DEF..."
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
            <p className="text-[10px] mt-1" style={{ color: "#a09080" }}>You can add this later from the agent detail page.</p>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={mutation.isPending} style={{ background: "#1a1f2e", color: "#e8dfd0" }}>
              {mutation.isPending ? "Creating..." : "Create Agent"}
            </Button>
          </div>
          {mutation.isError && (
            <p className="text-xs text-red-600">{(mutation.error as Error).message}</p>
          )}
        </form>
      </div>
    </div>
  );
}

// ── Staff Card ─────────────────────────────────────────────────────

function StaffCard({ agent }: { agent: StaffAgent }) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/staff/${agent.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff"] });
    },
  });

  const isButler = agent.isHeadButler || agent.staffRole === "head_butler";

  return (
    <Card
      className="border hover:shadow-sm transition-shadow"
      style={{
        borderColor: isButler ? "#8b6f4e" : "#ddd5c8",
        borderWidth: isButler ? "2px" : "1px",
      }}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold"
            style={{ background: isButler ? "#f5f0e8" : "#f0ede6", color: "#8b6f4e" }}
          >
            {agent.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={cn("w-2 h-2 rounded-full shrink-0", statusColor(agent.status))} />
              <Link
                to={`/staff/${agent.id}`}
                className="font-medium text-sm hover:underline"
                style={{ color: "#1a1f2e" }}
              >
                {agent.name}
              </Link>
            </div>
            <p className="text-xs" style={{ color: "#8a8070" }}>
              {isButler ? "Chief of Staff" : roleLabel(agent.staffRole)}
              {agent.specialty ? ` \u00B7 ${agent.specialty}` : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-2">
          <Badge variant={agent.status === "active" ? "success" : agent.status === "paused" ? "warning" : "secondary"} className="text-[10px]">
            {agent.status}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {MODEL_LABELS[agent.model ?? "claude-sonnet-4-6"] ?? agent.model}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {(agent.trustLevel ?? "restricted").charAt(0).toUpperCase() + (agent.trustLevel ?? "restricted").slice(1)} trust
          </Badge>
        </div>

        {agent.assignments && agent.assignments.length > 0 && (
          <div className="text-xs mb-2" style={{ color: "#a09080" }}>
            Assigned: {agent.assignments.map((a) => a.memberName).join(", ")}
          </div>
        )}

        <div className="flex justify-end gap-1">
          <Link to={`/staff/${agent.id}`}>
            <Button variant="ghost" size="sm" className="text-xs h-7" style={{ color: "#8a8070" }}>
              <UserCog className="h-3 w-3 mr-1" /> Manage
            </Button>
          </Link>
          {!isButler && (
            <>
              {confirmDelete ? (
                <div className="flex gap-1">
                  <Button
                    variant="destructive"
                    size="sm"
                    className="h-7 text-[10px] px-2"
                    onClick={() => deleteMutation.mutate()}
                    disabled={deleteMutation.isPending}
                  >
                    Confirm
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[10px] px-2"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-7 text-red-500 hover:text-red-600"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Household Page ─────────────────────────────────────────────────

export function HouseholdPage() {
  const [showAddMember, setShowAddMember] = useState(false);
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [interviewMemberId, setInterviewMemberId] = useState<string | null>(null);
  const [interviewMessages, setInterviewMessages] = useState<ChatMessage[]>([]);
  const queryClient = useQueryClient();

  const { data: householdData, isLoading: loadingHousehold } = useQuery<HouseholdData>({
    queryKey: ["household"],
    queryFn: () => api.get("/households/current"),
    retry: false,
  });

  const { data: staffData, isLoading: loadingStaff } = useQuery<{ staff: StaffAgent[] }>({
    queryKey: ["staff"],
    queryFn: () => api.get("/staff"),
    retry: false,
  });

  const members = householdData?.members || [];
  const staff = staffData?.staff || [];
  const householdId = householdData?.household?.id;

  // Build a lookup: memberId -> which staff are assigned to them
  function getStaffForMember(memberId: string) {
    return staff
      .filter((s) => s.assignments?.some((a) => a.memberId === memberId))
      .map((s) => ({ staffName: s.name, staffRole: roleLabel(s.staffRole) }));
  }

  // Profile interview
  const interviewMember = interviewMemberId
    ? members.find((m) => m.id === interviewMemberId)
    : null;

  const profileMutation = useMutation({
    mutationFn: (text: string) =>
      api.post<{ response: string; phase: string; profileDocument?: string }>(
        `/members/${interviewMemberId}/profile/interview`,
        { message: text },
      ),
    onSuccess: (data) => {
      setInterviewMessages((prev) => [
        ...prev,
        { role: "assistant" as const, content: data.response },
      ]);
      if (data.profileDocument) {
        queryClient.invalidateQueries({ queryKey: ["household"] });
      }
    },
  });

  const isProfileComplete = profileMutation.data?.profileDocument != null;

  function profileGreeting(name: string): string {
    return `Good, let's build a profile for ${name}. I'll ask a few questions to understand who they are so their agent can serve them well.\n\nLet's start with personality and temperament — how would you describe ${name}? Are they more energetic or reserved? Outgoing or introspective?`;
  }

  function handleStartInterview(memberId: string) {
    const member = members.find((m) => m.id === memberId);
    setInterviewMemberId(memberId);
    setInterviewMessages([
      { role: "assistant", content: profileGreeting(member?.name ?? "them") },
    ]);
  }

  function handleCloseInterview() {
    setInterviewMemberId(null);
    setInterviewMessages([]);
  }

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      {/* Family Members section */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2
              className="text-[22px] font-normal flex items-center gap-2"
              style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              <Users className="h-5 w-5" style={{ color: "#8a8070" }} />
              Family Members
            </h2>
            <p className="text-[13px] mt-1" style={{ color: "#7a7060" }}>
              {members.length} member{members.length !== 1 ? "s" : ""}
              {householdData?.household?.name ? ` \u00B7 ${householdData.household.name}` : ""}
            </p>
          </div>
          {householdId && (
            <Button
              size="sm"
              onClick={() => setShowAddMember(true)}
              disabled={showAddMember}
              style={{ background: "#1a1f2e", color: "#e8dfd0" }}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Member
            </Button>
          )}
        </div>

        {loadingHousehold && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {!loadingHousehold && !householdId && (
          <Card className="border" style={{ borderColor: "#ddd5c8" }}>
            <CardContent className="p-6 text-center">
              <Users className="h-8 w-8 mx-auto mb-3" style={{ color: "#ddd5c8" }} />
              <p className="text-sm" style={{ color: "#8a8070" }}>
                No household configured yet. Complete onboarding to get started.
              </p>
            </CardContent>
          </Card>
        )}

        {householdId && (() => {
          const parents = members.filter((m) => m.role === "parent");
          const children = members.filter((m) => m.role !== "parent");
          return (
            <div className="space-y-6">
              {showAddMember && (
                <AddMemberForm
                  householdId={householdId}
                  onClose={() => setShowAddMember(false)}
                />
              )}

              {/* Parents row */}
              {parents.length > 0 && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider mb-3" style={{ color: "#8a8070" }}>
                    Parents
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {parents.map((m) => (
                      <MemberCard
                        key={m.id}
                        member={m}
                        householdId={householdId}
                        staffAssignments={getStaffForMember(m.id)}
                        onStartInterview={handleStartInterview}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Connector line between parents and children */}
              {parents.length > 0 && children.length > 0 && (
                <div className="flex justify-center">
                  <div className="w-px h-6" style={{ background: "#ddd5c8" }} />
                </div>
              )}

              {/* Children row */}
              {children.length > 0 && (
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider mb-3" style={{ color: "#8a8070" }}>
                    Kids
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {children.map((m) => (
                      <MemberCard
                        key={m.id}
                        member={m}
                        householdId={householdId}
                        staffAssignments={getStaffForMember(m.id)}
                        onStartInterview={handleStartInterview}
                      />
                    ))}
                  </div>
                </div>
              )}

              {members.length === 0 && !showAddMember && (
                <p className="text-sm" style={{ color: "#8a8070" }}>
                  No members yet. Add your first family member.
                </p>
              )}
            </div>
          );
        })()}
      </div>

      {/* Profile Interview Overlay */}
      <InterviewOverlay
        title={interviewMember ? `Profile: ${interviewMember.name}` : "Profile Interview"}
        subtitle="Carson will ask questions to build a profile"
        isOpen={!!interviewMemberId}
        onClose={handleCloseInterview}
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ["household"] });
          handleCloseInterview();
        }}
        messages={interviewMessages}
        isLoading={profileMutation.isPending}
        isComplete={isProfileComplete}
        onSendMessage={(text) => {
          setInterviewMessages((prev) => [
            ...prev,
            { role: "user" as const, content: text },
          ]);
          profileMutation.mutate(text);
        }}
        onReset={() => {
          setInterviewMessages([
            { role: "assistant", content: profileGreeting(interviewMember?.name ?? "them") },
          ]);
        }}
      />

      {/* Add Staff Modal */}
      {showAddStaff && householdId && (
        <AddStaffModal
          householdId={householdId}
          members={members}
          onClose={() => setShowAddStaff(false)}
        />
      )}

      {/* Staff Agents section */}
      <div>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2
              className="text-[22px] font-normal flex items-center gap-2"
              style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              <Shield className="h-5 w-5" style={{ color: "#8a8070" }} />
              Staff Agents
            </h2>
            <p className="text-[13px] mt-1" style={{ color: "#7a7060" }}>
              {staff.length} agent{staff.length !== 1 ? "s" : ""}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setShowAddStaff(true)}
            disabled={showAddStaff}
            style={{ background: "#1a1f2e", color: "#e8dfd0" }}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Add Staff
          </Button>
        </div>

        {loadingStaff && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {staff.map((agent) => (
            <StaffCard key={agent.id} agent={agent} />
          ))}
          {staff.length === 0 && !showAddStaff && (
            <p className="text-sm col-span-full" style={{ color: "#8a8070" }}>
              No staff agents configured yet.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
