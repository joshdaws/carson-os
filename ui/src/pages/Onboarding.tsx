import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Check,
  ArrowRight,
  Plus,
  Trash2,
  Loader2,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

interface FamilyMember {
  name: string;
  age: string;
  role: "parent" | "kid";
  telegramUserId: string;
}

// ── Phase Indicator ────────────────────────────────────────────────

const STEPS = [
  { label: "Family" },
  { label: "Agent" },
  { label: "Ready" },
];

function StepIndicator({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-0">
      {STEPS.map((step, i) => (
        <div key={i} className="flex items-center">
          <div
            className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors",
            )}
            style={{
              background: i <= current ? "var(--carson-navy)" : "#eee8dd",
              color: i <= current ? "var(--carson-cream)" : "var(--carson-muted)",
            }}
          >
            {i < current ? <Check className="h-4 w-4" /> : i + 1}
          </div>
          <span
            className="text-[10px] ml-1.5 mr-3 hidden sm:inline"
            style={{ color: i <= current ? "var(--carson-navy)" : "var(--carson-muted)" }}
          >
            {step.label}
          </span>
          {i < STEPS.length - 1 && (
            <div
              className="w-8 h-px mx-1"
              style={{ background: i < current ? "var(--carson-navy)" : "var(--carson-border)" }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Step 1: Family Setup ──────────────────────────────────────────

function FamilyStep({
  householdName,
  setHouseholdName,
  members,
  setMembers,
  onContinue,
}: {
  householdName: string;
  setHouseholdName: (name: string) => void;
  members: FamilyMember[];
  setMembers: (members: FamilyMember[]) => void;
  onContinue: () => void;
}) {
  function addMember() {
    setMembers([...members, { name: "", age: "", role: "kid", telegramUserId: "" }]);
  }

  function removeMember(idx: number) {
    setMembers(members.filter((_, i) => i !== idx));
  }

  function updateMember(idx: number, updates: Partial<FamilyMember>) {
    setMembers(members.map((m, i) => (i === idx ? { ...m, ...updates } : m)));
  }

  const isValid =
    householdName.trim() &&
    members.length >= 1 &&
    members.every((m) => m.name.trim() && m.age.trim());

  return (
    <div className="max-w-lg mx-auto w-full">
      <h3
        className="text-xl font-normal mb-1"
        style={{ color: "var(--carson-navy)", fontFamily: "'Instrument Serif', Georgia, serif" }}
      >
        Your Family
      </h3>
      <p className="text-sm mb-6" style={{ color: "var(--carson-muted)" }}>
        Who's in your household? We'll set up the system around your family.
      </p>

      {/* Household name */}
      <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--carson-navy)" }}>
        Household Name
      </label>
      <Input
        value={householdName}
        onChange={(e) => setHouseholdName(e.target.value)}
        placeholder="The Smith Family"
        className="mb-5"
        style={{ borderColor: "var(--carson-border)" }}
      />

      {/* Family members */}
      <label className="text-xs font-medium block mb-2" style={{ color: "var(--carson-navy)" }}>
        Family Members
      </label>

      <div className="space-y-3 mb-4">
        {members.map((member, idx) => (
          <div
            key={idx}
            className="rounded-lg p-3 flex gap-2 items-start"
            style={{ background: "var(--carson-white)", border: "1px solid var(--carson-border)" }}
          >
            <div className="flex-1 space-y-2">
              <div className="flex gap-2">
                <Input
                  value={member.name}
                  onChange={(e) => updateMember(idx, { name: e.target.value })}
                  placeholder="Name"
                  className="flex-1"
                  style={{ borderColor: "var(--carson-border)" }}
                />
                <Input
                  value={member.age}
                  onChange={(e) => updateMember(idx, { age: e.target.value })}
                  placeholder="Age"
                  className="w-16"
                  type="number"
                  style={{ borderColor: "var(--carson-border)" }}
                />
              </div>
              <div className="flex gap-2">
                <select
                  value={member.role}
                  onChange={(e) => updateMember(idx, { role: e.target.value as "parent" | "kid" })}
                  className="text-xs rounded-md px-2 py-1.5 border"
                  style={{ borderColor: "var(--carson-border)", background: "var(--carson-ivory)" }}
                >
                  <option value="parent">Parent</option>
                  <option value="kid">Kid</option>
                </select>
                <Input
                  value={member.telegramUserId}
                  onChange={(e) => updateMember(idx, { telegramUserId: e.target.value })}
                  placeholder="Telegram User ID (optional)"
                  className="flex-1 text-xs"
                  style={{ borderColor: "var(--carson-border)" }}
                />
              </div>
            </div>
            {members.length > 1 && (
              <button
                onClick={() => removeMember(idx)}
                className="p-1.5 rounded hover:bg-red-50 transition-colors"
                style={{ color: "var(--carson-muted)" }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      <button
        onClick={addMember}
        className="flex items-center gap-1.5 text-xs mb-6 hover:underline"
        style={{ color: "var(--carson-burgundy)" }}
      >
        <Plus className="h-3.5 w-3.5" /> Add family member
      </button>

      <Button
        onClick={onContinue}
        disabled={!isValid}
        style={{ background: "var(--carson-navy)", color: "var(--carson-cream)" }}
      >
        Continue <ArrowRight className="h-4 w-4 ml-1" />
      </Button>
    </div>
  );
}

// ── Step 2: Agent Setup ───────────────────────────────────────────

function AgentStep({
  agentName,
  setAgentName,
  botToken,
  setBotToken,
  assignTo,
  setAssignTo,
  members,
  onComplete,
  isPending,
}: {
  agentName: string;
  setAgentName: (name: string) => void;
  botToken: string;
  setBotToken: (token: string) => void;
  assignTo: string;
  setAssignTo: (name: string) => void;
  members: FamilyMember[];
  onComplete: () => void;
  isPending: boolean;
}) {
  return (
    <div className="max-w-lg mx-auto w-full">
      <h3
        className="text-xl font-normal mb-1"
        style={{ color: "var(--carson-navy)", fontFamily: "'Instrument Serif', Georgia, serif" }}
      >
        Your Chief of Staff
      </h3>
      <p className="text-sm mb-6" style={{ color: "var(--carson-muted)" }}>
        This is your household's main digital assistant. You can rename them and create more agents later.
      </p>

      {/* Agent name */}
      <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--carson-navy)" }}>
        Agent Name
      </label>
      <Input
        value={agentName}
        onChange={(e) => setAgentName(e.target.value)}
        placeholder="Carson"
        className="mb-4"
        style={{ borderColor: "var(--carson-border)" }}
      />

      {/* Assign to */}
      <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--carson-navy)" }}>
        Assign to
      </label>
      <select
        value={assignTo}
        onChange={(e) => setAssignTo(e.target.value)}
        className="w-full text-sm rounded-md px-3 py-2 border mb-4"
        style={{ borderColor: "var(--carson-border)", background: "var(--carson-white)" }}
      >
        {members.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name} ({m.role})
          </option>
        ))}
        <option value="__all__">Everyone</option>
      </select>

      {/* Bot token */}
      <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--carson-navy)" }}>
        Telegram Bot Token
      </label>
      <Input
        type="password"
        value={botToken}
        onChange={(e) => setBotToken(e.target.value)}
        placeholder="123456:ABC-DEF..."
        className="mb-2"
        style={{ borderColor: "var(--carson-border)" }}
      />
      <p className="text-[11px] mb-6" style={{ color: "var(--carson-muted)" }}>
        Create a bot via @BotFather on Telegram, then paste the token here.
      </p>

      <div className="flex gap-3">
        <Button
          onClick={onComplete}
          disabled={isPending || !agentName.trim()}
          style={{ background: "var(--carson-navy)", color: "var(--carson-cream)" }}
        >
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Setting up...
            </>
          ) : (
            <>
              <Check className="h-4 w-4 mr-1" /> Finish Setup
            </>
          )}
        </Button>
        {!botToken.trim() && (
          <span className="text-[11px] self-center" style={{ color: "var(--carson-muted)" }}>
            You can add the bot token later from the dashboard.
          </span>
        )}
      </div>
    </div>
  );
}

// ── Step 3: Done ──────────────────────────────────────────────────

function DoneStep({ agentName }: { agentName: string }) {
  const navigate = useNavigate();

  return (
    <div className="max-w-lg mx-auto w-full text-center">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center mb-4 mx-auto"
        style={{ background: "#e8f5e9" }}
      >
        <Check className="h-8 w-8" style={{ color: "var(--carson-success)" }} />
      </div>
      <h3
        className="text-xl font-normal mb-2"
        style={{ color: "var(--carson-navy)", fontFamily: "'Instrument Serif', Georgia, serif" }}
      >
        You're all set
      </h3>
      <p className="text-sm mb-6" style={{ color: "var(--carson-muted)" }}>
        {agentName} is ready. Open Telegram and send a message to get started.
        <br />
        <span className="text-xs">You can set up the family constitution, agent personality, and more from the dashboard.</span>
      </p>
      <Button
        onClick={() => navigate("/")}
        style={{ background: "var(--carson-navy)", color: "var(--carson-cream)" }}
      >
        Go to Dashboard
      </Button>
    </div>
  );
}

// ── Onboarding Page ────────────────────────────────────────────────

export function OnboardingPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  // Step 1 state
  const [householdName, setHouseholdName] = useState("");
  const [members, setMembers] = useState<FamilyMember[]>([
    { name: "", age: "", role: "parent", telegramUserId: "" },
  ]);

  // Step 2 state
  const [agentName, setAgentName] = useState("Carson");
  const [botToken, setBotToken] = useState("");
  const [assignTo, setAssignTo] = useState("");

  // Check if already onboarded
  const { data: existing } = useQuery<{ household?: { id: string } }>({
    queryKey: ["household-check"],
    queryFn: () => api.get("/households/current"),
    retry: false,
  });

  useEffect(() => {
    if (existing?.household?.id) {
      navigate("/");
    }
  }, [existing, navigate]);

  // Set default assignTo when members change
  useEffect(() => {
    const firstParent = members.find((m) => m.role === "parent" && m.name.trim());
    if (firstParent && !assignTo) {
      setAssignTo(firstParent.name);
    }
  }, [members, assignTo]);

  // Complete onboarding
  const completeMutation = useMutation({
    mutationFn: () => {
      return api.post("/onboarding/complete", {
        householdName: householdName.trim(),
        members: members
          .filter((m) => m.name.trim())
          .map((m) => ({
            name: m.name.trim(),
            age: parseInt(m.age, 10) || 0,
            role: m.role,
            telegramUserId: m.telegramUserId.trim() || null,
          })),
        agent: {
          name: agentName.trim() || "Carson",
          botToken: botToken.trim() || null,
          assignTo: assignTo === "__all__" ? null : assignTo,
        },
      });
    },
    onSuccess: () => {
      setStep(2);
    },
  });

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "var(--carson-ivory)" }}
    >
      {/* Header */}
      <div className="py-6 px-6 text-center border-b" style={{ borderColor: "var(--carson-border)" }}>
        <h1
          className="text-lg font-bold tracking-wide"
          style={{ color: "var(--carson-navy)", fontFamily: "'Instrument Serif', Georgia, serif" }}
        >
          CarsonOS
        </h1>
        <p className="text-[11px] uppercase tracking-[2px] mt-1" style={{ color: "var(--carson-muted)" }}>
          Household Setup
        </p>
        <div className="mt-4">
          <StepIndicator current={step} />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col justify-center px-4 py-8">
        {step === 0 && (
          <FamilyStep
            householdName={householdName}
            setHouseholdName={setHouseholdName}
            members={members}
            setMembers={setMembers}
            onContinue={() => setStep(1)}
          />
        )}

        {step === 1 && (
          <AgentStep
            agentName={agentName}
            setAgentName={setAgentName}
            botToken={botToken}
            setBotToken={setBotToken}
            assignTo={assignTo}
            setAssignTo={setAssignTo}
            members={members.filter((m) => m.name.trim())}
            onComplete={() => completeMutation.mutate()}
            isPending={completeMutation.isPending}
          />
        )}

        {step === 2 && <DoneStep agentName={agentName || "Carson"} />}
      </div>
    </div>
  );
}
