import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { DollarSign, TrendingUp } from "lucide-react";
import { Link } from "react-router-dom";

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
  agent?: {
    id: string;
    status: string;
    model: string;
    budgetMonthlyCents: number;
    spentMonthlyCents: number;
  };
}

interface BudgetOverview {
  totalSpentCents: number;
  totalBudgetCents: number;
  members: MemberBudget[];
}

interface MemberBudget {
  memberId: string;
  memberName: string;
  agentId: string;
  model: string;
  spentCents: number;
  budgetCents: number;
}

// --- Helpers ---

function budgetColor(pct: number): string {
  if (pct > 80) return "text-red-600";
  if (pct > 50) return "text-yellow-600";
  return "text-green-600";
}

function barColorClass(pct: number): string {
  if (pct > 80) return "[&>div]:bg-red-500";
  if (pct > 50) return "[&>div]:bg-yellow-500";
  return "[&>div]:bg-green-500";
}

// --- Sub-components ---

function OverviewCard({
  totalSpent,
  totalBudget,
}: {
  totalSpent: number;
  totalBudget: number;
}) {
  const pct =
    totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  const spentStr = (totalSpent / 100).toFixed(2);
  const budgetStr = (totalBudget / 100).toFixed(2);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Monthly Overview
            </p>
            <p className="text-2xl font-bold mt-1">${spentStr}</p>
            <p className="text-xs text-muted-foreground mt-1">
              of ${budgetStr} budget ({pct}% used)
            </p>
          </div>
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
        </div>
        <Progress value={pct} max={100} className="mt-2" />
      </CardContent>
    </Card>
  );
}

function MemberBudgetRow({
  member,
  onSave,
  isSaving,
}: {
  member: MemberBudget;
  onSave: (agentId: string, cents: number) => void;
  isSaving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(
    (member.budgetCents / 100).toFixed(0),
  );

  const pct =
    member.budgetCents > 0
      ? Math.round((member.spentCents / member.budgetCents) * 100)
      : 0;
  const spentStr = (member.spentCents / 100).toFixed(2);
  const budgetStr = (member.budgetCents / 100).toFixed(2);
  const modelLabel = member.model?.includes("haiku")
    ? "Haiku"
    : member.model?.includes("sonnet")
      ? "Sonnet"
      : member.model?.includes("opus")
        ? "Opus"
        : "---";

  const handleSave = () => {
    const cents = Math.round(parseFloat(draft) * 100);
    if (!isNaN(cents) && cents >= 0) {
      onSave(member.agentId, cents);
      setEditing(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold text-muted-foreground">
            {member.memberName.charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <Link
                to={`/agents/${member.agentId}`}
                className="font-medium text-sm hover:underline"
              >
                {member.memberName}
              </Link>
              <span className="text-xs text-muted-foreground">
                {modelLabel}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-muted-foreground">
                ${spentStr} / ${budgetStr}
              </span>
              <span className={cn("text-xs font-medium", budgetColor(pct))}>
                {pct}%
              </span>
            </div>
          </div>

          {editing ? (
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="h-7 text-xs w-20"
                min={0}
                autoFocus
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleSave}
                disabled={isSaving}
                className="h-7 text-xs"
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setDraft((member.budgetCents / 100).toFixed(0));
                }}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              className="h-7 text-xs text-muted-foreground"
            >
              <DollarSign className="h-3 w-3 mr-1" />
              Edit
            </Button>
          )}
        </div>
        <Progress
          value={pct}
          max={100}
          className={barColorClass(pct)}
        />
      </CardContent>
    </Card>
  );
}

// --- Page ---

export function BudgetPage() {
  const queryClient = useQueryClient();

  const { data: familyData } = useQuery<FamilyData>({
    queryKey: ["family"],
    queryFn: () => api.get("/families/current"),
    retry: false,
  });

  const familyId = familyData?.family?.id;

  const { data: budgetData, isLoading } = useQuery<BudgetOverview>({
    queryKey: ["budget", familyId],
    queryFn: () => api.get(`/families/${familyId}/budget`),
    enabled: !!familyId,
  });

  const patchBudget = useMutation({
    mutationFn: ({
      agentId,
      budgetMonthlyCents,
    }: {
      agentId: string;
      budgetMonthlyCents: number;
    }) => api.patch(`/agents/${agentId}`, { budgetMonthlyCents }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["budget", familyId] });
      queryClient.invalidateQueries({ queryKey: ["family"] });
    },
  });

  const handleSave = (agentId: string, cents: number) => {
    patchBudget.mutate({ agentId, budgetMonthlyCents: cents });
  };

  // Build member list from either budget endpoint or family data
  const members: MemberBudget[] =
    budgetData?.members ||
    (familyData?.members || [])
      .filter((m) => m.agent)
      .map((m) => ({
        memberId: m.id,
        memberName: m.name,
        agentId: m.agent!.id,
        model: m.agent!.model,
        spentCents: m.agent!.spentMonthlyCents,
        budgetCents: m.agent!.budgetMonthlyCents,
      }));

  const totalSpent =
    budgetData?.totalSpentCents ||
    members.reduce((s, m) => s + m.spentCents, 0);
  const totalBudget =
    budgetData?.totalBudgetCents ||
    members.reduce((s, m) => s + m.budgetCents, 0);

  if (isLoading) {
    return (
      <div className="p-6 max-w-4xl">
        <p className="text-sm text-muted-foreground">Loading budget...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Budget</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Cost tracking and monthly limits
        </p>
      </div>

      <div className="mb-6">
        <OverviewCard totalSpent={totalSpent} totalBudget={totalBudget} />
      </div>

      <h3 className="text-sm font-semibold mb-3">Per-Member Breakdown</h3>

      {members.length === 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">
              No agents configured yet.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {members.map((m) => (
          <MemberBudgetRow
            key={m.memberId}
            member={m}
            onSave={handleSave}
            isSaving={patchBudget.isPending}
          />
        ))}
      </div>
    </div>
  );
}
