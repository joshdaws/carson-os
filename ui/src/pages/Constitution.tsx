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
import {
  Plus,
  Trash2,
  Shield,
  Eye,
  Lock,
  MessageSquare,
  DollarSign,
  KeyRound,
  AlertTriangle,
  ScrollText,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EnforcementLevel = "hard" | "soft" | "advisory";
type RuleCategory =
  | "content-governance"
  | "interaction-mode"
  | "privacy"
  | "budget"
  | "access"
  | "escalation";
type MemberRole = "parent" | "student" | "child";

interface ConstitutionRule {
  id: string;
  ruleText: string;
  enforcementLevel: EnforcementLevel;
  evaluationType: string;
  category: RuleCategory;
  roleScope?: MemberRole[];
  ageScope?: { min?: number; max?: number };
}

interface Constitution {
  id: string;
  version: number;
  rules: ConstitutionRule[];
}

interface ConstitutionData {
  constitution: Constitution;
}

interface FamilyData {
  family: { id: string; name: string; timezone: string };
  members: { id: string; name: string; role: string; age: number }[];
}

interface CreateRulePayload {
  ruleText: string;
  enforcementLevel: EnforcementLevel;
  evaluationType: string;
  category: RuleCategory;
  roleScope?: MemberRole[];
}

interface UpdateRulePayload {
  ruleText?: string;
  enforcementLevel?: EnforcementLevel;
  roleScope?: MemberRole[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES: { value: RuleCategory; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "content-governance", label: "Content Governance", icon: Shield },
  { value: "interaction-mode", label: "Interaction Mode", icon: MessageSquare },
  { value: "privacy", label: "Privacy", icon: Eye },
  { value: "budget", label: "Budget", icon: DollarSign },
  { value: "access", label: "Access", icon: KeyRound },
  { value: "escalation", label: "Escalation", icon: AlertTriangle },
];

const ENFORCEMENT_OPTIONS: { value: EnforcementLevel; label: string }[] = [
  { value: "hard", label: "Hard" },
  { value: "soft", label: "Soft" },
  { value: "advisory", label: "Advisory" },
];

const EVALUATION_OPTIONS = [
  { value: "pre-response", label: "Pre-response" },
  { value: "post-response", label: "Post-response" },
  { value: "periodic", label: "Periodic" },
  { value: "on-demand", label: "On-demand" },
];

const ROLE_OPTIONS: MemberRole[] = ["parent", "student", "child"];

function enforcementVariant(level: EnforcementLevel) {
  if (level === "hard") return "destructive" as const;
  if (level === "soft") return "warning" as const;
  return "secondary" as const;
}

// ---------------------------------------------------------------------------
// Inline Editable Rule Text
// ---------------------------------------------------------------------------

function EditableRuleText({
  text,
  onSave,
  disabled,
}: {
  text: string;
  onSave: (newText: string) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function handleBlur() {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== text) {
      onSave(trimmed);
    } else {
      setDraft(text);
    }
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      (e.target as HTMLInputElement).blur();
    }
    if (e.key === "Escape") {
      setDraft(text);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        className="h-7 text-sm"
      />
    );
  }

  return (
    <span
      className="text-sm cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 transition-colors"
      onClick={() => {
        setDraft(text);
        setEditing(true);
      }}
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Role Scope Checkboxes
// ---------------------------------------------------------------------------

function RoleScopeSelector({
  selected,
  onChange,
}: {
  selected: MemberRole[];
  onChange: (roles: MemberRole[]) => void;
}) {
  function toggle(role: MemberRole) {
    if (selected.includes(role)) {
      onChange(selected.filter((r) => r !== role));
    } else {
      onChange([...selected, role]);
    }
  }

  return (
    <div className="flex gap-2">
      {ROLE_OPTIONS.map((role) => (
        <label key={role} className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={selected.includes(role)}
            onChange={() => toggle(role)}
            className="rounded border-input h-3 w-3"
          />
          {role.charAt(0).toUpperCase() + role.slice(1)}
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single Rule Row
// ---------------------------------------------------------------------------

function RuleRow({
  rule,
  familyId,
  constitutionId,
}: {
  rule: ConstitutionRule;
  familyId: string;
  constitutionId: string;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (payload: UpdateRulePayload) =>
      api.patch(`/families/${familyId}/constitution/rules/${rule.id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["constitution"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      api.delete(`/families/${familyId}/constitution/rules/${rule.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["constitution"] });
    },
  });

  function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteMutation.mutate();
  }

  return (
    <div className="flex gap-3 py-3 border-b border-dashed border-border/50 last:border-0 group">
      <span className="text-muted-foreground/50 pt-0.5 select-none font-serif">
        &#167;
      </span>

      <div className="flex-1 min-w-0 space-y-1.5">
        <EditableRuleText
          text={rule.ruleText}
          onSave={(newText) => updateMutation.mutate({ ruleText: newText })}
          disabled={updateMutation.isPending}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={rule.enforcementLevel}
            onValueChange={(v) =>
              updateMutation.mutate({ enforcementLevel: v as EnforcementLevel })
            }
          >
            <SelectTrigger className="h-6 w-[90px] text-[10px] border-none shadow-none px-0">
              <Badge
                variant={enforcementVariant(rule.enforcementLevel)}
                className="text-[10px] pointer-events-none"
              >
                {rule.enforcementLevel}
              </Badge>
            </SelectTrigger>
            <SelectContent>
              {ENFORCEMENT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {rule.evaluationType && (
            <span className="text-[10px] text-muted-foreground">
              {rule.evaluationType}
            </span>
          )}

          <div className="ml-auto">
            <RoleScopeSelector
              selected={rule.roleScope || []}
              onChange={(roles) => updateMutation.mutate({ roleScope: roles })}
            />
          </div>
        </div>
      </div>

      <div className="flex items-start pt-0.5">
        {confirmDelete ? (
          <div className="flex gap-1">
            <Button
              variant="destructive"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "..." : "Confirm"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={handleDelete}
          >
            <Trash2 className="h-3 w-3 text-muted-foreground" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Rule Form (inline at bottom of category)
// ---------------------------------------------------------------------------

function AddRuleForm({
  familyId,
  category,
  onClose,
}: {
  familyId: string;
  category: RuleCategory;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [ruleText, setRuleText] = useState("");
  const [enforcement, setEnforcement] = useState<EnforcementLevel>("soft");
  const [evaluationType, setEvaluationType] = useState("pre-response");
  const [roleScope, setRoleScope] = useState<MemberRole[]>([]);

  const createMutation = useMutation({
    mutationFn: (payload: CreateRulePayload) =>
      api.post(`/families/${familyId}/constitution/rules`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["constitution"] });
      onClose();
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ruleText.trim()) return;
    createMutation.mutate({
      ruleText: ruleText.trim(),
      enforcementLevel: enforcement,
      evaluationType,
      category,
      ...(roleScope.length > 0 ? { roleScope } : {}),
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-3 p-3 rounded-md border border-dashed border-border space-y-3"
    >
      <Input
        placeholder="Rule text..."
        value={ruleText}
        onChange={(e) => setRuleText(e.target.value)}
        autoFocus
      />

      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Enforcement
          </label>
          <Select value={enforcement} onValueChange={(v) => setEnforcement(v as EnforcementLevel)}>
            <SelectTrigger className="h-8 w-[110px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENFORCEMENT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Evaluation
          </label>
          <Select value={evaluationType} onValueChange={setEvaluationType}>
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVALUATION_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Applies to
          </label>
          <RoleScopeSelector selected={roleScope} onChange={setRoleScope} />
        </div>
      </div>

      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={createMutation.isPending || !ruleText.trim()}>
          {createMutation.isPending ? "Adding..." : "Add Rule"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>

      {createMutation.isError && (
        <p className="text-xs text-destructive">
          {(createMutation.error as Error).message || "Failed to add rule."}
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Category Section
// ---------------------------------------------------------------------------

function CategorySection({
  category,
  rules,
  familyId,
  constitutionId,
}: {
  category: (typeof CATEGORIES)[number];
  rules: ConstitutionRule[];
  familyId: string;
  constitutionId: string;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const Icon = category.icon;

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{category.label}</h3>
          <span className="text-xs text-muted-foreground">
            {rules.length} rule{rules.length !== 1 ? "s" : ""}
          </span>
        </div>
        {!showAddForm && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => setShowAddForm(true)}
          >
            <Plus className="h-3 w-3 mr-1" />
            Add
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          {rules.length === 0 && !showAddForm && (
            <p className="text-sm text-muted-foreground py-2">
              No rules yet. Add your first {category.label.toLowerCase()} rule.
            </p>
          )}

          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              familyId={familyId}
              constitutionId={constitutionId}
            />
          ))}

          {showAddForm && (
            <AddRuleForm
              familyId={familyId}
              category={category.value}
              onClose={() => setShowAddForm(false)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ConstitutionPage() {
  const { data: familyData } = useQuery<FamilyData>({
    queryKey: ["family"],
    queryFn: () => api.get("/families/current"),
    retry: false,
  });

  const familyId = familyData?.family?.id;

  const {
    data: constitutionData,
    isLoading,
  } = useQuery<ConstitutionData>({
    queryKey: ["constitution", familyId],
    queryFn: () => api.get(`/families/${familyId}/constitution`),
    enabled: !!familyId,
  });

  const constitution = constitutionData?.constitution;
  const rules = constitution?.rules || [];

  // Group rules by category, preserving category order
  const rulesByCategory = CATEGORIES.reduce(
    (acc, cat) => {
      acc[cat.value] = rules.filter((r) => r.category === cat.value);
      return acc;
    },
    {} as Record<RuleCategory, ConstitutionRule[]>,
  );

  const totalRules = rules.length;

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <ScrollText className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-xl font-semibold">Family Constitution</h2>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {constitution
              ? `Version ${constitution.version} · ${totalRules} rule${totalRules !== 1 ? "s" : ""}`
              : "Governance rules for your family's AI agents"}
          </p>
        </div>
      </div>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading constitution...</p>
      )}

      {!isLoading && !familyId && (
        <Card>
          <CardContent className="p-6 text-center">
            <ScrollText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No family configured yet. Complete onboarding to set up your constitution.
            </p>
          </CardContent>
        </Card>
      )}

      {familyId && constitution && (
        <div>
          {CATEGORIES.map((category) => (
            <CategorySection
              key={category.value}
              category={category}
              rules={rulesByCategory[category.value]}
              familyId={familyId}
              constitutionId={constitution.id}
            />
          ))}
        </div>
      )}

      {familyId && !isLoading && !constitution && (
        <Card>
          <CardContent className="p-6 text-center">
            <ScrollText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No constitution found. The constitution is created during family onboarding.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
