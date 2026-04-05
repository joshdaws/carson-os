import { useState } from "react";
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
import { Plus, Pencil, X, Check, User } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MemberRole = "parent" | "student" | "child";

interface Agent {
  id: string;
  status: "active" | "paused" | "idle";
  model: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
}

interface FamilyMember {
  id: string;
  name: string;
  role: MemberRole;
  age: number;
  telegramUserId?: string | null;
  agent?: Agent;
}

interface Family {
  id: string;
  name: string;
  timezone: string;
}

interface FamilyData {
  family: Family;
  members: FamilyMember[];
}

interface CreateMemberPayload {
  name: string;
  role: MemberRole;
  age: number;
  telegramUserId?: string;
}

interface UpdateMemberPayload {
  name?: string;
  role?: MemberRole;
  age?: number;
  telegramUserId?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROLE_OPTIONS: { value: MemberRole; label: string }[] = [
  { value: "parent", label: "Parent" },
  { value: "student", label: "Student" },
  { value: "child", label: "Child" },
];

function modelForRole(role: MemberRole): string {
  return role === "parent" ? "sonnet" : "haiku";
}

function budgetForRole(role: MemberRole): string {
  if (role === "parent") return "$20";
  if (role === "student") return "$5";
  return "$2";
}

function statusVariant(status: string | undefined) {
  if (status === "active") return "success" as const;
  if (status === "paused") return "warning" as const;
  return "secondary" as const;
}

// ---------------------------------------------------------------------------
// Add Member Form
// ---------------------------------------------------------------------------

function AddMemberForm({
  familyId,
  onClose,
}: {
  familyId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<MemberRole>("child");
  const [age, setAge] = useState("");
  const [telegramUserId, setTelegramUserId] = useState("");

  const createMutation = useMutation({
    mutationFn: (payload: CreateMemberPayload) =>
      api.post(`/families/${familyId}/members`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["family"] });
      onClose();
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !age) return;
    createMutation.mutate({
      name: name.trim(),
      role,
      age: parseInt(age, 10),
      ...(telegramUserId.trim() ? { telegramUserId: telegramUserId.trim() } : {}),
    });
  }

  return (
    <Card>
      <CardContent className="p-4">
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium">New Member</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              type="number"
              placeholder="Age"
              min={1}
              max={99}
              value={age}
              onChange={(e) => setAge(e.target.value)}
            />
            <Input
              placeholder="Telegram ID (optional)"
              value={telegramUserId}
              onChange={(e) => setTelegramUserId(e.target.value)}
            />
          </div>

          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              Model: {modelForRole(role)} · Budget: {budgetForRole(role)}/mo
            </p>
            <Button type="submit" size="sm" disabled={createMutation.isPending || !name.trim() || !age}>
              {createMutation.isPending ? "Adding..." : "Add Member"}
            </Button>
          </div>

          {createMutation.isError && (
            <p className="text-xs text-destructive">
              {(createMutation.error as Error).message || "Failed to add member."}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Member Card
// ---------------------------------------------------------------------------

function MemberCard({
  member,
  familyId,
}: {
  member: FamilyMember;
  familyId: string;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [role, setRole] = useState<MemberRole>(member.role);
  const [age, setAge] = useState(String(member.age));
  const [telegramUserId, setTelegramUserId] = useState(member.telegramUserId || "");

  const updateMutation = useMutation({
    mutationFn: (payload: UpdateMemberPayload) =>
      api.patch(`/families/${familyId}/members/${member.id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["family"] });
      setEditing(false);
    },
  });

  function handleSave() {
    const payload: UpdateMemberPayload = {};
    if (name.trim() !== member.name) payload.name = name.trim();
    if (role !== member.role) payload.role = role;
    if (parseInt(age, 10) !== member.age) payload.age = parseInt(age, 10);
    const trimmedTg = telegramUserId.trim() || null;
    if (trimmedTg !== (member.telegramUserId || null)) payload.telegramUserId = trimmedTg;

    if (Object.keys(payload).length === 0) {
      setEditing(false);
      return;
    }
    updateMutation.mutate(payload);
  }

  function handleCancel() {
    setName(member.name);
    setRole(member.role);
    setAge(String(member.age));
    setTelegramUserId(member.telegramUserId || "");
    setEditing(false);
  }

  const agentStatus = member.agent?.status || "idle";
  const model = modelForRole(member.role);
  const budget = budgetForRole(member.role);

  if (editing) {
    return (
      <Card className="border-foreground/20">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium">Edit Member</span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleSave}
                disabled={updateMutation.isPending || !name.trim() || !age}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={handleCancel}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            <Select value={role} onValueChange={(v) => setRole(v as MemberRole)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Input
              type="number"
              placeholder="Age"
              min={1}
              max={99}
              value={age}
              onChange={(e) => setAge(e.target.value)}
            />
            <Input
              placeholder="Telegram ID (optional)"
              value={telegramUserId}
              onChange={(e) => setTelegramUserId(e.target.value)}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Model: {modelForRole(role)} · Budget: {budgetForRole(role)}/mo
          </p>

          {updateMutation.isError && (
            <p className="text-xs text-destructive">
              {(updateMutation.error as Error).message || "Failed to update."}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="hover:border-foreground/20 transition-colors">
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold text-muted-foreground">
            {member.name.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "w-2 h-2 rounded-full",
                  agentStatus === "active"
                    ? "bg-green-500"
                    : agentStatus === "paused"
                      ? "bg-orange-400"
                      : "bg-muted-foreground/30",
                )}
              />
              <span className="font-medium text-sm truncate">{member.name}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {member.role.charAt(0).toUpperCase() + member.role.slice(1)}
              {member.age ? ` (${member.age})` : ""} · {model}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant={statusVariant(agentStatus)} className="text-[10px]">
            {agentStatus}
          </Badge>
          <span className="text-muted-foreground">Budget: {budget}/mo</span>
          {member.telegramUserId && (
            <span className="text-muted-foreground">
              TG: {member.telegramUserId}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function FamilyPage() {
  const [showAddForm, setShowAddForm] = useState(false);

  const { data, isLoading } = useQuery<FamilyData>({
    queryKey: ["family"],
    queryFn: () => api.get("/families/current"),
    retry: false,
  });

  const members = data?.members || [];
  const familyId = data?.family?.id;

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Family Members</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {members.length} member{members.length !== 1 ? "s" : ""}
            {data?.family?.name ? ` · ${data.family.name}` : ""}
          </p>
        </div>
        {familyId && (
          <Button
            size="sm"
            onClick={() => setShowAddForm(true)}
            disabled={showAddForm}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Member
          </Button>
        )}
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading family data...</p>
      )}

      {!isLoading && !familyId && (
        <Card>
          <CardContent className="p-6 text-center">
            <User className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No family configured yet. Complete onboarding to get started.
            </p>
          </CardContent>
        </Card>
      )}

      {familyId && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {showAddForm && (
            <AddMemberForm
              familyId={familyId}
              onClose={() => setShowAddForm(false)}
            />
          )}

          {members.map((member) => (
            <MemberCard key={member.id} member={member} familyId={familyId} />
          ))}

          {members.length === 0 && !showAddForm && (
            <p className="text-sm text-muted-foreground col-span-full">
              No members yet. Add your first family member to get started.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
