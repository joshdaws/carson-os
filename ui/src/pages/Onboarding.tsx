import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Plus, Trash2, Users, Check, Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MemberRole = "parent" | "student" | "child";

interface OnboardingMember {
  name: string;
  role: MemberRole;
  age: string;
}

interface TemplateRule {
  id: string;
  label: string;
  ruleText: string;
  category: string;
  enforcementLevel: "hard" | "soft" | "advisory";
  evaluationType: string;
  appliesToRoles: MemberRole[];
  enabled: boolean;
}

interface OnboardingPayload {
  familyName: string;
  timezone: string;
  members: { name: string; role: MemberRole; age: number }[];
  rules: {
    category: string;
    ruleText: string;
    enforcementLevel: string;
    evaluationType: string;
    appliesToRoles: MemberRole[];
  }[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Anchorage", label: "Alaska (AKT)" },
  { value: "Pacific/Honolulu", label: "Hawaii (HT)" },
  { value: "UTC", label: "UTC" },
];

const ROLE_OPTIONS: { value: MemberRole; label: string }[] = [
  { value: "parent", label: "Parent" },
  { value: "student", label: "Student" },
  { value: "child", label: "Child" },
];

function modelForRole(role: MemberRole): string {
  return role === "parent" ? "sonnet" : "haiku";
}

function budgetForRole(role: MemberRole): string {
  if (role === "parent") return "$20/mo";
  if (role === "student") return "$5/mo";
  return "$2/mo";
}

const DEFAULT_TEMPLATE_RULES: TemplateRule[] = [
  {
    id: "coaching",
    label: "Coaching Mode",
    ruleText:
      "Agents coach through problems, never give direct answers to homework",
    category: "interaction-mode",
    enforcementLevel: "soft",
    evaluationType: "behavioral",
    appliesToRoles: ["student", "child"],
    enabled: true,
  },
  {
    id: "privacy",
    label: "Privacy",
    ruleText:
      "No agent may share family financial details, schedules, or personal info externally",
    category: "privacy",
    enforcementLevel: "hard",
    evaluationType: "pre-response",
    appliesToRoles: ["parent", "student", "child"],
    enabled: true,
  },
  {
    id: "age-appropriate",
    label: "Age-Appropriate Content",
    ruleText:
      "Children's agents cannot discuss age-inappropriate topics without parent escalation",
    category: "content-governance",
    enforcementLevel: "hard",
    evaluationType: "pre-response",
    appliesToRoles: ["student", "child"],
    enabled: true,
  },
  {
    id: "parent-visibility",
    label: "Parent Visibility",
    ruleText:
      "Parent agents have full visibility into all child agent conversations",
    category: "access",
    enforcementLevel: "hard",
    evaluationType: "periodic",
    appliesToRoles: ["parent"],
    enabled: true,
  },
];

// ---------------------------------------------------------------------------
// Step Indicator
// ---------------------------------------------------------------------------

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-0 mb-8">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="flex items-center">
          <div
            className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors",
              i < current
                ? "bg-primary text-primary-foreground"
                : i === current
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground",
            )}
          >
            {i < current ? (
              <Check className="h-4 w-4" />
            ) : (
              i + 1
            )}
          </div>
          {i < total - 1 && (
            <div
              className={cn(
                "w-16 h-px mx-1",
                i < current ? "bg-primary" : "bg-border",
              )}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle Switch (inline, no separate component file needed)
// ---------------------------------------------------------------------------

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors",
        checked ? "bg-primary" : "bg-secondary",
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-3.5 w-3.5 rounded-full bg-background shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Family Basics
// ---------------------------------------------------------------------------

function StepFamilyBasics({
  familyName,
  setFamilyName,
  timezone,
  setTimezone,
  onNext,
}: {
  familyName: string;
  setFamilyName: (v: string) => void;
  timezone: string;
  setTimezone: (v: string) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold tracking-tight">
          Welcome to CarsonOS
        </h2>
        <p className="text-muted-foreground mt-2">
          Your family's values, your family's AI.
        </p>
      </div>

      <Card>
        <CardContent className="p-6 space-y-5">
          <div className="space-y-2">
            <label className="text-sm font-medium">Family Name</label>
            <Input
              placeholder="The Daws Family"
              value={familyName}
              onChange={(e) => setFamilyName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Timezone</label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger>
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>
                    {tz.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button
          onClick={onNext}
          disabled={!familyName.trim() || !timezone}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Family Values & Constitution
// ---------------------------------------------------------------------------

function StepConstitution({
  rules,
  setRules,
  worldview,
  setWorldview,
  budgetCap,
  setBudgetCap,
  onBack,
  onNext,
}: {
  rules: TemplateRule[];
  setRules: (rules: TemplateRule[]) => void;
  worldview: string;
  setWorldview: (v: string) => void;
  budgetCap: string;
  setBudgetCap: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const toggleRule = useCallback(
    (id: string) => {
      setRules(
        rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
      );
    },
    [rules, setRules],
  );

  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold tracking-tight">
          What matters to your family?
        </h2>
        <p className="text-muted-foreground mt-2">
          Set the ground rules for how AI agents interact with your family.
        </p>
      </div>

      <Card>
        <CardContent className="p-6 space-y-5">
          {/* Template rules */}
          <div className="space-y-3">
            {rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-start gap-3 py-3 border-b border-dashed border-border/50 last:border-0"
              >
                <div className="pt-0.5">
                  <Toggle
                    checked={rule.enabled}
                    onChange={() => toggleRule(rule.id)}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm font-medium">{rule.label}</span>
                    <span
                      className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded",
                        rule.enforcementLevel === "hard"
                          ? "bg-red-100 text-red-700"
                          : rule.enforcementLevel === "soft"
                            ? "bg-orange-100 text-orange-700"
                            : "bg-secondary text-muted-foreground",
                      )}
                    >
                      {rule.enforcementLevel}
                    </span>
                  </div>
                  <p
                    className={cn(
                      "text-xs",
                      rule.enabled
                        ? "text-muted-foreground"
                        : "text-muted-foreground/50",
                    )}
                  >
                    {rule.ruleText}
                  </p>
                  <p className="text-[10px] text-muted-foreground/60 mt-1">
                    Applies to:{" "}
                    {rule.appliesToRoles
                      .map((r) => r.charAt(0).toUpperCase() + r.slice(1))
                      .join(", ")}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* Worldview */}
          <div className="space-y-2 pt-2 border-t">
            <label className="text-sm font-medium">
              Family Worldview{" "}
              <span className="text-muted-foreground font-normal">
                (optional)
              </span>
            </label>
            <Textarea
              placeholder="e.g., Reformed Christian worldview"
              value={worldview}
              onChange={(e) => setWorldview(e.target.value)}
              rows={2}
            />
            <p className="text-[10px] text-muted-foreground">
              This frames how agents approach questions of values, ethics, and
              worldview.
            </p>
          </div>

          {/* Budget cap */}
          <div className="space-y-2 pt-2 border-t">
            <label className="text-sm font-medium">
              Monthly Budget Cap
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                type="number"
                min={1}
                max={10000}
                value={budgetCap}
                onChange={(e) => setBudgetCap(e.target.value)}
                className="w-32"
              />
              <span className="text-sm text-muted-foreground">/ month</span>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Total spending limit across all agents. Individual agent budgets
              are assigned by role.
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>Next</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Family Members
// ---------------------------------------------------------------------------

function StepMembers({
  members,
  setMembers,
  onBack,
  onSubmit,
  isSubmitting,
  error,
}: {
  members: OnboardingMember[];
  setMembers: (members: OnboardingMember[]) => void;
  onBack: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
  error: Error | null;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<MemberRole>("parent");
  const [age, setAge] = useState("");

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !age) return;
    setMembers([...members, { name: name.trim(), role, age }]);
    setName("");
    setRole("parent");
    setAge("");
  }

  function handleRemove(index: number) {
    setMembers(members.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold tracking-tight">
          Who's in the family?
        </h2>
        <p className="text-muted-foreground mt-2">
          Add each family member. Each gets their own AI agent.
        </p>
      </div>

      {/* Add member form */}
      <Card>
        <CardContent className="p-6">
          <form onSubmit={handleAdd} className="space-y-3">
            <span className="text-sm font-medium">Add a Member</span>
            <div className="grid grid-cols-3 gap-3">
              <Input
                placeholder="Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Select
                value={role}
                onValueChange={(v) => setRole(v as MemberRole)}
              >
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
              <Input
                type="number"
                placeholder="Age"
                min={1}
                max={99}
                value={age}
                onChange={(e) => setAge(e.target.value)}
              />
            </div>
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Model: {modelForRole(role)} / Budget: {budgetForRole(role)}
              </p>
              <Button
                type="submit"
                size="sm"
                disabled={!name.trim() || !age}
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Member list */}
      {members.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="space-y-0">
              {members.map((member, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 py-3 border-b border-dashed border-border/50 last:border-0"
                >
                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-semibold text-muted-foreground">
                    {member.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{member.name}</span>
                    <p className="text-xs text-muted-foreground">
                      {member.role.charAt(0).toUpperCase() +
                        member.role.slice(1)}{" "}
                      ({member.age}) / {modelForRole(member.role)} /{" "}
                      {budgetForRole(member.role)}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleRemove(i)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {members.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center">
            <Users className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No members yet. Add at least one family member to continue.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Telegram info */}
      <div className="rounded-md bg-secondary/50 px-4 py-3">
        <p className="text-xs text-muted-foreground">
          After setup, each member can connect their Telegram account from the
          dashboard. Telegram is how family members talk to their agents day to
          day.
        </p>
      </div>

      {error && (
        <p className="text-sm text-destructive text-center">
          {error.message || "Something went wrong. Please try again."}
        </p>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={onSubmit}
          disabled={members.length === 0 || isSubmitting}
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
              Setting up...
            </>
          ) : (
            "Complete Setup"
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  // Step 1 state
  const [familyName, setFamilyName] = useState("");
  const [timezone, setTimezone] = useState("America/New_York");

  // Step 2 state
  const [rules, setRules] = useState<TemplateRule[]>(DEFAULT_TEMPLATE_RULES);
  const [worldview, setWorldview] = useState("");
  const [budgetCap, setBudgetCap] = useState("50");

  // Step 3 state
  const [members, setMembers] = useState<OnboardingMember[]>([]);

  // Submit mutation
  const submitMutation = useMutation({
    mutationFn: (payload: OnboardingPayload) =>
      api.post("/onboarding", payload),
    onSuccess: () => {
      navigate("/");
    },
  });

  function handleSubmit() {
    // Build enabled rules
    const enabledRules = rules
      .filter((r) => r.enabled)
      .map((r) => ({
        category: r.category,
        ruleText: r.ruleText,
        enforcementLevel: r.enforcementLevel,
        evaluationType: r.evaluationType,
        appliesToRoles: r.appliesToRoles,
      }));

    // Add worldview rule if provided
    if (worldview.trim()) {
      enabledRules.push({
        category: "content-governance",
        ruleText: worldview.trim(),
        enforcementLevel: "soft",
        evaluationType: "behavioral",
        appliesToRoles: ["parent", "student", "child"],
      });
    }

    // Add budget rule
    if (budgetCap) {
      enabledRules.push({
        category: "budget",
        ruleText: `Monthly family budget cap: $${budgetCap}`,
        enforcementLevel: "hard",
        evaluationType: "periodic",
        appliesToRoles: ["parent", "student", "child"],
      });
    }

    submitMutation.mutate({
      familyName: familyName.trim(),
      timezone,
      members: members.map((m) => ({
        name: m.name,
        role: m.role,
        age: parseInt(m.age, 10),
      })),
      rules: enabledRules,
    });
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-[600px]">
        {/* Logo */}
        <div className="text-center mb-6">
          <h1 className="text-base font-bold tracking-tight">CarsonOS</h1>
        </div>

        {/* Step indicator */}
        <StepIndicator current={step} total={3} />

        {/* Steps */}
        {step === 0 && (
          <StepFamilyBasics
            familyName={familyName}
            setFamilyName={setFamilyName}
            timezone={timezone}
            setTimezone={setTimezone}
            onNext={() => setStep(1)}
          />
        )}

        {step === 1 && (
          <StepConstitution
            rules={rules}
            setRules={setRules}
            worldview={worldview}
            setWorldview={setWorldview}
            budgetCap={budgetCap}
            setBudgetCap={setBudgetCap}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}

        {step === 2 && (
          <StepMembers
            members={members}
            setMembers={setMembers}
            onBack={() => setStep(1)}
            onSubmit={handleSubmit}
            isSubmitting={submitMutation.isPending}
            error={
              submitMutation.isError
                ? (submitMutation.error as Error)
                : null
            }
          />
        )}
      </div>
    </div>
  );
}
