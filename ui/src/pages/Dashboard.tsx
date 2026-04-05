import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { Users, MessageSquare, DollarSign, Shield } from "lucide-react";
import { Link } from "react-router-dom";

interface Agent {
  id: string;
  status: string;
  model: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
}

interface Member {
  id: string;
  name: string;
  role: string;
  age: number;
  agent?: Agent;
}

interface FamilyData {
  family: { id: string; name: string; timezone: string };
  members: Member[];
}

interface DashboardStats {
  activeAgents: number;
  totalAgents: number;
  messagesToday: number;
  totalSpentCents: number;
  totalBudgetCents: number;
  policyEventsToday: number;
}

interface ActivityEntry {
  id: string;
  agentId: string | null;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  agentName?: string;
}

interface ConstitutionRule {
  id: string;
  ruleText: string;
  enforcementLevel: string;
  category: string;
}

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
            <p className="text-xs text-muted-foreground mt-1">{detail}</p>
          </div>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </CardContent>
    </Card>
  );
}

function MemberCard({ member }: { member: Member }) {
  const agent = member.agent;
  const isActive = agent?.status === "active";
  const budgetPct = agent ? Math.round((agent.spentMonthlyCents / Math.max(agent.budgetMonthlyCents, 1)) * 100) : 0;
  const spentDollars = agent ? (agent.spentMonthlyCents / 100).toFixed(2) : "0.00";

  const roleLabel = member.role === "parent" ? "Parent" : member.role === "student" ? `Student (${member.age})` : `Child (${member.age})`;
  const modelLabel = agent?.model?.includes("haiku") ? "haiku" : agent?.model?.includes("sonnet") ? "sonnet" : agent?.model?.includes("opus") ? "opus" : "---";

  return (
    <Link to={agent ? `/agents/${agent.id}` : "#"} className="block">
      <Card className="hover:border-foreground/20 transition-colors">
        <CardContent className="p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-sm font-semibold text-muted-foreground">
              {member.name.charAt(0)}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className={cn("w-2 h-2 rounded-full", isActive ? "bg-green-500" : "bg-muted-foreground/30")} />
                <span className="font-medium text-sm">{member.name}</span>
              </div>
              <p className="text-xs text-muted-foreground">{roleLabel} · {modelLabel}</p>
            </div>
          </div>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>Cost: ${spentDollars}</span>
          </div>
          <Progress value={budgetPct} max={100} className="mt-2" />
        </CardContent>
      </Card>
    </Link>
  );
}

function ActivityItem({ entry }: { entry: ActivityEntry }) {
  const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const details = entry.details as Record<string, string> | null;
  const policyTag = details?.policyTag;

  return (
    <div className="flex gap-3 px-4 py-2.5 border-b border-border/50 last:border-0 text-sm">
      <span className="text-xs text-muted-foreground min-w-[48px] pt-0.5">{time}</span>
      <div className="flex-1">
        {entry.agentName && <span className="font-medium">{entry.agentName}'s agent </span>}
        <span className="text-muted-foreground">{entry.action}</span>
        {policyTag && (
          <Badge
            variant={policyTag === "escalated" ? "destructive" : policyTag === "enforced" ? "warning" : "secondary"}
            className="ml-2 text-[10px]"
          >
            {policyTag}
          </Badge>
        )}
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { data: familyData } = useQuery<FamilyData>({
    queryKey: ["family"],
    queryFn: () => api.get("/families/current"),
    retry: false,
  });

  const familyId = familyData?.family?.id;

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["dashboard", "stats", familyId],
    queryFn: () => api.get(`/families/${familyId}/budget`),
    enabled: !!familyId,
  });

  const { data: activityData } = useQuery<{ activity: ActivityEntry[] }>({
    queryKey: ["dashboard", "activity", familyId],
    queryFn: () => api.get(`/families/${familyId}/activity?limit=20`),
    enabled: !!familyId,
  });

  const { data: constitutionData } = useQuery<{ constitution: { rules: ConstitutionRule[] } }>({
    queryKey: ["dashboard", "constitution", familyId],
    queryFn: () => api.get(`/families/${familyId}/constitution`),
    enabled: !!familyId,
  });

  const members = familyData?.members || [];
  const activeCount = members.filter((m) => m.agent?.status === "active").length;
  const totalBudgetCents = members.reduce((sum, m) => sum + (m.agent?.budgetMonthlyCents || 0), 0);
  const totalSpentCents = members.reduce((sum, m) => sum + (m.agent?.spentMonthlyCents || 0), 0);

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">Family Dashboard</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {today} · {members.length} members, {activeCount} active agents
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Active Agents"
          value={`${activeCount} / ${members.length}`}
          detail={`${members.length - activeCount} idle`}
          icon={Users}
        />
        <StatCard
          label="Messages Today"
          value={stats?.messagesToday?.toString() || "0"}
          detail="across all agents"
          icon={MessageSquare}
        />
        <StatCard
          label="Budget Used"
          value={`$${(totalSpentCents / 100).toFixed(2)}`}
          detail={`of $${(totalBudgetCents / 100).toFixed(2)} monthly cap`}
          icon={DollarSign}
        />
        <StatCard
          label="Policy Events"
          value={stats?.policyEventsToday?.toString() || "0"}
          detail="today"
          icon={Shield}
        />
      </div>

      <div className="mb-8">
        <h3 className="text-sm font-semibold mb-3">Family Members</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {members.map((m) => (
            <MemberCard key={m.id} member={m} />
          ))}
          {members.length === 0 && (
            <p className="text-sm text-muted-foreground col-span-full">
              No family members yet. <Link to="/onboarding" className="underline">Set up your family</Link>.
            </p>
          )}
        </div>
      </div>

      {constitutionData?.constitution?.rules && constitutionData.constitution.rules.length > 0 && (
        <Card className="mb-8">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3">Family Constitution (active rules)</h3>
            <div className="space-y-1">
              {constitutionData.constitution.rules.slice(0, 6).map((rule) => (
                <div key={rule.id} className="flex gap-2 py-1.5 text-sm text-muted-foreground border-b border-dashed border-border/50 last:border-0">
                  <span className="text-muted-foreground/60">&#167;</span>
                  <span>{rule.ruleText}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <div className="px-4 py-3 border-b">
          <h3 className="text-sm font-semibold">Live Activity</h3>
        </div>
        <div>
          {activityData?.activity?.map((entry) => (
            <ActivityItem key={entry.id} entry={entry} />
          ))}
          {(!activityData?.activity || activityData.activity.length === 0) && (
            <p className="text-sm text-muted-foreground p-4">No activity yet. Start by setting up your family.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
