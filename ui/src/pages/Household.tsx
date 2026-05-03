import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField, useDirtyGuard } from "@/components/ui/form-field";
import { PageShell } from "@/components/page-shell";
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
  createdAt?: string;
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
  memoryDir?: string | null;
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
  "claude-opus-4-7": "Opus 4.7",
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
            <IconButton aria-label="Close form" size="sm" onClick={onClose}>
              <X />
            </IconButton>
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
  const [memoryDir, setMemoryDir] = useState(member.memoryDir || "");
  const [memoryDirValid, setMemoryDirValid] = useState<boolean | null>(null);
  const [memoryDirResolved, setMemoryDirResolved] = useState<string | null>(null);
  const [confirmRemoveProps, askRemoveConfirm] = useConfirmDialog();
  // Closing the editor without saving prompts before discarding changes.
  // markDirty() fires on any input change; markClean() fires after a
  // successful save mutation. The X button uses guardClose so the user
  // doesn't lose unsaved edits to a stray click.
  const dirtyGuard = useDirtyGuard();

  const updateMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.put(`/households/${householdId}/members/${member.id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["household"] });
      toast.success("Member updated");
      dirtyGuard.markClean();
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
    const md = memoryDir.trim() || null;
    if (md !== (member.memoryDir || null)) payload.memoryDir = md;
    if (Object.keys(payload).length === 0) { onClose(); return; }
    updateMutation.mutate(payload);
  }

  return (
    <Card className="border-2" style={{ borderColor: "#8b6f4e" }}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium" style={{ color: "#1a1f2e" }}>Edit Member</span>
          <div className="flex gap-1">
            <IconButton
              aria-label="Save changes"
              size="sm"
              onClick={handleSave}
              disabled={updateMutation.isPending}
            >
              <Check />
            </IconButton>
            <IconButton
              aria-label="Cancel editing"
              size="sm"
              onClick={() => dirtyGuard.guardClose(onClose)}
            >
              <X />
            </IconButton>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Name" name="member-name" autoComplete="given-name">
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); dirtyGuard.markDirty(); }}
              autoFocus
            />
          </FormField>
          <FormField label="Role" controlId={`member-role-${member.id}`}>
            <Select
              value={role}
              onValueChange={(v) => { setRole(v as MemberRole); dirtyGuard.markDirty(); }}
            >
              <SelectTrigger id={`member-role-${member.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Age" name="member-age" autoComplete="off">
            <Input
              type="number"
              min={1}
              max={99}
              value={age}
              onChange={(e) => { setAge(e.target.value); dirtyGuard.markDirty(); }}
            />
          </FormField>
          <FormField label="Telegram ID" name="member-telegram" autoComplete="off">
            <Input
              value={telegramUserId}
              onChange={(e) => { setTelegramUserId(e.target.value); dirtyGuard.markDirty(); }}
            />
          </FormField>
        </div>
        {/* Memory folder — the validation icons sit beside the input rather
            than inside the FormField child so cloneElement injects id +
            aria-* onto the actual <Input> (not the wrapper div). v0.5.5
            review caught the wrapper-targeting bug; structure now matches
            FormField's input-shaped-child contract. */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <FormField
              label="Memory folder"
              name="member-memory-dir"
              autoComplete="off"
              error={
                memoryDir && memoryDirValid === false
                  ? "Directory not found"
                  : undefined
              }
              helper={
                memoryDir && memoryDirValid === true && memoryDirResolved
                  ? memoryDirResolved
                  : !memoryDir
                    ? `Default: ~/.carsonos/memory/${member.name.toLowerCase().replace(/\s+/g, "-")}`
                    : undefined
              }
            >
              <Input
                placeholder="leave blank for default"
                value={memoryDir}
                onChange={(e) => {
                  setMemoryDir(e.target.value);
                  setMemoryDirValid(null);
                  dirtyGuard.markDirty();
                }}
                onBlur={() => {
                  const requested = memoryDir.trim();
                  if (!requested) { setMemoryDirValid(null); setMemoryDirResolved(null); return; }
                  // Snapshot the path the user blurred with. If they edit the
                  // input again before the response lands, the response is
                  // stale and must not bless the new text. Without this guard
                  // the user could see "valid" on a path they never typed.
                  api.get<{ valid: boolean; resolved: string }>(`/settings/validate-path?path=${encodeURIComponent(requested)}`)
                    .then((r) => {
                      if (memoryDir.trim() !== requested) return;
                      setMemoryDirValid(r.valid);
                      setMemoryDirResolved(r.resolved);
                    })
                    .catch(() => {
                      if (memoryDir.trim() !== requested) return;
                      setMemoryDirValid(false);
                    });
                }}
                style={{ fontFamily: "monospace", fontSize: "12px" }}
              />
            </FormField>
          </div>
          {memoryDirValid === true && (
            <Check className="h-4 w-4 shrink-0 mb-3" aria-label="Path valid" style={{ color: "#2e7d32" }} />
          )}
          {memoryDirValid === false && (
            <X className="h-4 w-4 shrink-0 mb-3" aria-label="Path invalid" style={{ color: "#c62828" }} />
          )}
        </div>
        {staffAssignments.length > 0 && (
          <div className="pt-2 border-t" style={{ borderColor: "#eee8dd" }}>
            <p className="text-[10px] uppercase tracking-wider mb-1.5 text-carson-text-muted">
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
          {/* Remove fires through ConfirmDialog — issue #49. Removing a
              household member detaches their assigned staff and is not
              undoable, so it gets the same confirmation pattern as
              StaffCard's delete. */}
          <Button
            variant="ghost"
            size="sm"
            className="text-red-600 hover:text-red-700 hover:bg-red-50 text-xs"
            onClick={() =>
              askRemoveConfirm(async () => {
                await deleteMutation.mutateAsync();
              })
            }
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
      <ConfirmDialog
        {...confirmRemoveProps}
        title={`Remove ${member.name}?`}
        description={
          <p>
            This removes {member.name} from the household. Any staff agents
            assigned to {member.name} will be detached. Memory files on disk
            are kept; this is reversible by re-adding the member with the
            same name.
          </p>
        }
        confirmLabel="Remove"
        tone="destructive"
      />
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
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold text-carson-text-muted"
            style={{ background: "#f0ede6" }}
          >
            {member.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <span className="font-medium text-sm" style={{ color: "#1a1f2e" }}>
              {member.name}
            </span>
            <p className="text-xs text-carson-text-muted">
              {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
              {member.age ? ` (${member.age})` : ""}
            </p>
          </div>
          {/* Member edit — issue #45 audit flagged this 28x28 unlabeled
              icon-button. IconButton wraps with 44x44 hit area and
              "Edit member" name for screen-readers. */}
          <IconButton
            aria-label="Edit member"
            size="md"
            className="shrink-0"
            onClick={() => setEditing(true)}
          >
            <Pencil />
          </IconButton>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs mb-2">
          {member.telegramUserId && (
            <span className="text-carson-text-muted">TG: {member.telegramUserId}</span>
          )}
          {staffAssignments.length > 0 && (
            <span className="text-carson-text-meta">
              Staff: {staffAssignments.map((s) => s.staffName).join(", ")}
            </span>
          )}
        </div>
        {/* Profile CTA — a single button that tells you the state. If the
            profile is built, a check glyph + "Re-interview" affords updates.
            If empty, a muted "+" reads as a create action. */}
        <div className="flex justify-end pt-2 border-t" style={{ borderColor: "#eee8dd" }}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            style={{ color: hasProfile ? "#2e7d32" : "#8b6f4e" }}
            onClick={() => onStartInterview(member.id)}
          >
            {hasProfile ? (
              <>
                <Check className="h-3 w-3 mr-1" />
                Re-interview
              </>
            ) : (
              <>
                <Plus className="h-3 w-3 mr-1" />
                Build profile
              </>
            )}
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
  // AddStaffModal is a true modal — closing without save loses the typed
  // name + role choices. guardClose on Cancel + outside-click prompts
  // before discarding.
  const dirtyGuard = useDirtyGuard();
  // useId-derived prefix so two AddStaffModal instances mounted at once
  // don't collide on the hardcoded `staff-role` / `staff-model` ids.
  const uid = useId();

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post("/staff", payload) as Promise<{ agent: { id: string } }>,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["staff"] });
      dirtyGuard.markClean();
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
      onClick={(e) => {
        if (e.target === e.currentTarget) dirtyGuard.guardClose(onClose);
      }}
      // Escape closes via guardClose just like the X button + Cancel + outside
      // click. v0.5.5 review caught that this raw <div> modal was missing the
      // Escape handler that radix Dialog gets for free; users typing into the
      // form expect Esc to back out.
      onKeyDown={(e) => {
        if (e.key === "Escape") dirtyGuard.guardClose(onClose);
      }}
      tabIndex={-1}
    >
      <div
        className="rounded-lg shadow-xl w-full max-w-md mx-4 max-h-[90dvh] overflow-y-auto"
        style={{ background: "#faf6ef", border: "1px solid #ddd5c8" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "#eee8dd" }}>
          <h3 className="text-base font-medium font-serif text-carson-text-primary">
            New Staff Agent
          </h3>
          <IconButton
            aria-label="Close dialog"
            size="md"
            onClick={() => dirtyGuard.guardClose(onClose)}
          >
            <X />
          </IconButton>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <FormField
            label="Name"
            required
            name="staff-name"
            autoComplete="off"
            error={nameError ? "Name is required" : undefined}
          >
            <Input
              placeholder="e.g., Django"
              value={name}
              onChange={(e) => { setName(e.target.value); dirtyGuard.markDirty(); }}
              autoFocus
              style={nameError ? { borderColor: "#c62828" } : undefined}
            />
          </FormField>

          {/* Role + Assign to */}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Role" controlId={`${uid}-staff-role`}>
              <Select
                value={staffRole}
                onValueChange={(v) => { setStaffRole(v as StaffRole); dirtyGuard.markDirty(); }}
              >
                <SelectTrigger id={`${uid}-staff-role`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STAFF_ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Assign to" controlId={`${uid}-staff-assign-to`}>
              <Select
                value={assignTo}
                onValueChange={(v) => { setAssignTo(v); dirtyGuard.markDirty(); }}
              >
                <SelectTrigger id={`${uid}-staff-assign-to`}><SelectValue placeholder="Select member..." /></SelectTrigger>
                <SelectContent>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name} ({m.role})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          {/* Model + Trust Level */}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Model" controlId={`${uid}-staff-model`}>
              <Select
                value={model}
                onValueChange={(v) => { setModel(v); dirtyGuard.markDirty(); }}
              >
                <SelectTrigger id={`${uid}-staff-model`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField label="Trust Level" controlId={`${uid}-staff-trust`}>
              <Select
                value={trustLevel}
                onValueChange={(v) => { setTrustLevel(v as TrustLevel); dirtyGuard.markDirty(); }}
              >
                <SelectTrigger id={`${uid}-staff-trust`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TRUST_LEVEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                      <span className="text-[10px] ml-1.5 text-carson-text-muted">{o.description}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>

          <FormField
            label="Telegram Bot Token (optional)"
            name="staff-bot-token"
            autoComplete="off"
            helper="You can add this later from the agent detail page."
          >
            <Input
              type="password"
              placeholder="123456:ABC-DEF..."
              value={botToken}
              onChange={(e) => { setBotToken(e.target.value); dirtyGuard.markDirty(); }}
            />
          </FormField>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => dirtyGuard.guardClose(onClose)}
            >
              Cancel
            </Button>
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
  const toast = useToast();
  const [confirmProps, askConfirm] = useConfirmDialog();

  const isButler = agent.isHeadButler || agent.staffRole === "head_butler";
  const isPersonal = agent.staffRole === "personal";
  const isHired = !isButler && !isPersonal;

  // "Tools specialist" / "Research specialist" — drop the internal "Custom ·"
  // prefix for hired staff since the section already says Staff.
  const roleSubtitle = isButler
    ? "Chief of Staff"
    : isHired && agent.specialty
      ? `${agent.specialty.charAt(0).toUpperCase()}${agent.specialty.slice(1)} specialist`
      : roleLabel(agent.staffRole);

  // Relative "on staff 3d" — only shown on hired staff cards, near the avatar,
  // so the user sees provenance at a glance.
  const onStaffFor = (() => {
    if (!isHired || !agent.createdAt) return null;
    const ms = Date.now() - new Date(agent.createdAt).getTime();
    const days = Math.floor(ms / 86_400_000);
    if (days < 1) return "today";
    if (days < 7) return `${days}d`;
    if (days < 30) return `${Math.floor(days / 7)}w`;
    if (days < 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
  })();

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/staff/${agent.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["staff"] });
      toast.success(`${agent.name} removed`);
    },
    onError: (err: Error) => {
      // 409 carries actionable text ("cancel these tasks first: …" /
      // "delete these tools first: …"). The ConfirmDialog auto-closes on
      // resolution; surface server errors via toast.
      toast.error(err.message);
    },
  });

  return (
    <Card
      className="border hover:shadow-sm transition-shadow"
      // Chief of Staff: warm cream fill signals "special" without the 2px
      // gold border that used to read as "currently selected."
      style={{
        borderColor: "#ddd5c8",
        borderWidth: "1px",
        background: isButler ? "#fbf7ef" : undefined,
      }}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-2">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold"
            style={{ background: isButler ? "#f5e8cc" : "#f0ede6", color: "#8b6f4e" }}
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
              {onStaffFor && (
                <span
                  className="text-[10px] shrink-0 text-carson-text-meta"
                  title={`on staff since ${agent.createdAt}`}
                >
                  · {onStaffFor}
                </span>
              )}
            </div>
            <p className="text-xs text-carson-text-muted">
              {roleSubtitle}
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
          <div className="text-xs mb-2 text-carson-text-meta">
            Assigned: {agent.assignments.map((a) => a.memberName).join(", ")}
          </div>
        )}

        <div className="flex justify-end gap-1 items-center">
          <Link to={`/staff/${agent.id}`}>
            <Button variant="ghost" size="sm" className="text-xs h-7 text-carson-text-muted">
              <UserCog className="h-3 w-3 mr-1" /> Manage
            </Button>
          </Link>
          {!isButler && (
            // Issue #49 — delete now goes through ConfirmDialog with the
            // agent's name in the title. Replaces the inline two-step
            // pattern so the trigger has a single accessible name and
            // the confirmation includes context (server 409s still surface
            // via toast since the dialog can't render arbitrary errors).
            <IconButton
              aria-label="Delete agent"
              variant="destructive"
              size="sm"
              onClick={() =>
                askConfirm(async () => {
                  try {
                    await deleteMutation.mutateAsync();
                  } catch {
                    // Server errors surface via the toast in mutation.onError.
                  }
                })
              }
              disabled={deleteMutation.isPending}
            >
              <Trash2 />
            </IconButton>
          )}
        </div>
      </CardContent>
      <ConfirmDialog
        {...confirmProps}
        title={`Delete ${agent.name}?`}
        description={
          <>
            <p>
              This permanently removes {agent.name} from the household. Any
              scheduled tasks or tool registrations they own must be moved
              or removed first — the server will block the delete and
              return the specifics if so.
            </p>
          </>
        }
        confirmLabel="Delete"
        tone="destructive"
      />
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

  // Split for the two-section layout:
  //   personal = Chief of Staff + assigned personal agents (the ones users text)
  //   hired    = custom-role specialists (hired via Carson, delegated to)
  // Other legacy roles (tutor/coach/scheduler) count as hired since they're
  // not chat-facing. Carson always sorts first in Personal.
  const personalAgents = staff
    .filter((a) => a.isHeadButler || a.staffRole === "head_butler" || a.staffRole === "personal")
    .sort((a, b) => {
      if (a.isHeadButler && !b.isHeadButler) return -1;
      if (!a.isHeadButler && b.isHeadButler) return 1;
      return a.name.localeCompare(b.name);
    });
  const hiredStaff = staff
    .filter((a) => !a.isHeadButler && a.staffRole !== "head_butler" && a.staffRole !== "personal")
    .sort((a, b) => a.name.localeCompare(b.name));

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
    <PageShell maxWidth="5xl">
      {/* Family Members section */}
      <div className="mb-10">
        <PageShell.Header>
          <div>
            <h2 className="text-[22px] font-normal flex items-center gap-2 font-serif text-carson-text-primary">
              <Users className="h-5 w-5 text-carson-text-muted" />
              Family Members
            </h2>
            <p className="text-[13px] mt-1 text-carson-text-meta">
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
        </PageShell.Header>

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
              <p className="text-sm text-carson-text-muted">
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

              {/* Parents — matches Personal/Staff serif heading style. No
                  icon on people sections; icons differentiate agent sections. */}
              {parents.length > 0 && (
                <div>
                  <div className="mb-5">
                    <h2 className="text-[22px] font-normal font-serif text-carson-text-primary">
                      Parents
                    </h2>
                    <p className="text-[13px] mt-1 text-carson-text-meta">
                      {parents.length} {parents.length === 1 ? "adult" : "adults"} in the household.
                    </p>
                  </div>
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

              {/* Kids */}
              {children.length > 0 && (
                <div>
                  <div className="mb-5">
                    <h2 className="text-[22px] font-normal font-serif text-carson-text-primary">
                      Kids
                    </h2>
                    <p className="text-[13px] mt-1 text-carson-text-meta">
                      {children.length} {children.length === 1 ? "kid" : "kids"} in the household.
                    </p>
                  </div>
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
                <p className="text-sm text-carson-text-muted">
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

      {/* Personal agents section — the ones you text with on Telegram/Signal.
          Sorted: Chief of Staff first, then personal agents by name.
          mb-10 matches the Family Members section's bottom gap so the
          Personal → Staff transition has the same breathing room as the
          rest of the page. */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-[22px] font-normal flex items-center gap-2 font-serif text-carson-text-primary">
              <Users className="h-5 w-5 text-carson-text-muted" />
              Personal agents
            </h2>
            <p className="text-[13px] mt-1 text-carson-text-meta">
              The ones you text with. {personalAgents.length} agent{personalAgents.length !== 1 ? "s" : ""}.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setShowAddStaff(true)}
            disabled={showAddStaff}
            style={{ background: "#1a1f2e", color: "#e8dfd0" }}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Add personal
          </Button>
        </div>

        {loadingStaff && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {personalAgents.map((agent) => (
            <StaffCard key={agent.id} agent={agent} />
          ))}
          {!loadingStaff && personalAgents.length === 0 && !showAddStaff && (
            <p className="text-sm col-span-full text-carson-text-muted">
              No personal agents yet.
            </p>
          )}
        </div>
      </div>

      {/* Staff section — hired specialists Carson can delegate to.
          These don't have a dedicated chat — you talk to Carson, Carson
          hands work off. Hired via `propose_hire` from Carson, not this page. */}
      <div>
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-[22px] font-normal flex items-center gap-2 font-serif text-carson-text-primary">
              <Shield className="h-5 w-5 text-carson-text-muted" />
              Staff
            </h2>
            <p className="text-[13px] mt-1 text-carson-text-meta">
              Hired specialists Carson delegates to. {hiredStaff.length} on staff.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {hiredStaff.map((agent) => (
            <StaffCard key={agent.id} agent={agent} />
          ))}
          {!loadingStaff && hiredStaff.length === 0 && (
            <div
              className="col-span-full p-4 rounded text-sm"
              style={{ background: "#faf6ed", color: "#5a4a2e", border: "1px solid #eee8dd" }}
            >
              No staff hired yet. Ask Carson to hire a specialist — e.g., "Carson, hire a Developer to help me build tools" or "hire a researcher named Lex."
            </div>
          )}
        </div>
      </div>
    </PageShell>
  );
}
