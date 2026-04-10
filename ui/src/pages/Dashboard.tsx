import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, Link as LinkIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { OnboardingChecklist } from "@/components/OnboardingChecklist";

// ── Types ──────────────────────────────────────────────────────────

interface StaffAgent {
  id: string;
  name: string;
  staffRole: string;
  specialty: string | null;
  roleContent: string;
  soulContent: string | null;
  visibility: string;
  telegramBotToken: string | null;
  model: string;
  status: string;
  isHeadButler: boolean;
  autonomyLevel: string;
  assignments?: { memberId: string; memberName: string; relationship: string }[];
}

interface HouseholdMember {
  id: string;
  name: string;
  role: string;
  age?: number;
}

interface ChecklistItem {
  key: string;
  label: string;
  required: boolean;
  complete: boolean;
}

interface ChecklistData {
  items: ChecklistItem[];
  completedCount: number;
  totalCount: number;
}

interface HouseholdData {
  household: { id: string; name: string; timezone?: string };
  members: HouseholdMember[];
  checklist?: ChecklistData;
}

interface Task {
  id: string;
  title: string;
  status: string;
  agentId: string;
  agentName?: string;
  parentTaskId: string | null;
  result: string | null;
  createdAt: number;
}

interface ActivityEntry {
  id: string;
  type: string;
  agentId?: string;
  agentName?: string;
  action: string;
  policyClause?: string;
  createdAt: string;
}

// ── Color palette ─────────────────────────────────────────────────
// Warm Downton palette, consistent with Layout.tsx sidebar colors

const C = {
  navy: "#1a1f2e",
  navyLight: "#242a3a",
  cream: "#f5f1eb",
  creamDark: "#e8dfd0",
  burgundy: "#8b6f4e",
  burgundyDeep: "#6b4f3e",
  textPrimary: "#2c2c2c",
  textSecondary: "#6a6050",
  textMuted: "#8a8070",
  textFaint: "#a09080",
  border: "#ddd5c8",
  borderLight: "#eee8dd",
  cardBg: "#faf8f4",
  headButlerBg: "#f5f0e8",
  headButlerBorder: "#8b6f4e",
  statusActive: "#4a7c59",
  statusPaused: "#b8860b",
  statusIdle: "#8a8070",
  serif: "Georgia, 'Times New Roman', serif",
} as const;

// ── Helpers ────────────────────────────────────────────────────────

function formatTime(dateStr: string | number): string {
  const d = typeof dateStr === "number" ? new Date(dateStr) : new Date(dateStr);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatStaffRole(role: string, isChief: boolean): string {
  if (isChief) return "Chief of Staff";
  const map: Record<string, string> = {
    personal: "Personal Assistant",
    tutor: "Tutor",
    coach: "Coach",
    scheduler: "Scheduler",
    custom: "Custom",
  };
  return map[role] || role.charAt(0).toUpperCase() + role.slice(1);
}

function getStatusColor(status: string): string {
  if (status === "active") return C.statusActive;
  if (status === "paused") return C.statusPaused;
  return C.statusIdle;
}

function isSetupIncomplete(agent: StaffAgent): boolean {
  return agent.soulContent === null || agent.telegramBotToken === null;
}

// Build a lookup: memberId -> list of agent names assigned to them
function buildMemberAgentMap(staff: StaffAgent[]): Map<string, StaffAgent[]> {
  const map = new Map<string, StaffAgent[]>();
  for (const agent of staff) {
    if (agent.assignments) {
      for (const a of agent.assignments) {
        const existing = map.get(a.memberId) || [];
        existing.push(agent);
        map.set(a.memberId, existing);
      }
    }
  }
  return map;
}

// Build a lookup: agentId -> list of member names
function buildAgentMemberMap(staff: StaffAgent[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const agent of staff) {
    if (agent.assignments) {
      map.set(agent.id, agent.assignments.map((a) => a.memberName));
    }
  }
  return map;
}

// ── Zone 1: Family Members ────────────────────────────────────────

function FamilyMemberCard({
  member,
  linkedAgents,
}: {
  member: HouseholdMember;
  linkedAgents: StaffAgent[];
}) {
  const isParent = member.role === "parent";
  const hasAgent = linkedAgents.length > 0;

  return (
    <div
      className="relative rounded-lg px-4 py-3 min-w-[140px] text-center"
      data-member-id={member.id}
      style={{
        border: isParent ? `2px solid ${C.navy}` : `1.5px solid ${C.border}`,
        background: isParent ? C.headButlerBg : C.cardBg,
      }}
    >
      <div
        className="text-sm font-semibold"
        style={{ color: C.navy }}
      >
        {member.name}
      </div>

      <div className="mt-1">
        <Badge
          variant="outline"
          className="text-[10px] px-2 py-0"
          style={{
            borderColor: isParent ? C.burgundy : C.border,
            color: isParent ? C.burgundy : C.textMuted,
          }}
        >
          {member.role === "parent" ? "Parent" : "Kid"}
        </Badge>
        {member.age && (
          <span
            className="text-[11px] ml-1.5"
            style={{ color: C.textMuted }}
          >
            {member.age}
          </span>
        )}
      </div>

      <div className="mt-1.5 text-[10px]" style={{ color: hasAgent ? C.burgundy : C.textFaint }}>
        {hasAgent ? (
          <span className="flex items-center justify-center gap-1">
            <LinkIcon className="h-2.5 w-2.5" />
            {linkedAgents.map((a) => a.name).join(", ")}
          </span>
        ) : (
          "No agent assigned"
        )}
      </div>
    </div>
  );
}

function FamilyZone({
  members,
  memberAgentMap,
}: {
  members: HouseholdMember[];
  memberAgentMap: Map<string, StaffAgent[]>;
}) {
  const parents = members.filter((m) => m.role === "parent");
  const children = members.filter((m) => m.role !== "parent");

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h3
          className="text-sm font-semibold tracking-wide"
          style={{ color: C.navy, letterSpacing: "0.5px" }}
        >
          Family
        </h3>
        <span
          className="text-[10px] uppercase tracking-[2px]"
          style={{ color: C.textMuted }}
        >
          {members.length} members
        </span>
      </div>

      {/* Parents row */}
      {parents.length > 0 && (
        <div className="flex flex-wrap gap-3 justify-center mb-3">
          {parents.map((m) => (
            <FamilyMemberCard
              key={m.id}
              member={m}
              linkedAgents={memberAgentMap.get(m.id) || []}
            />
          ))}
        </div>
      )}

      {/* Children row */}
      {children.length > 0 && (
        <div className="flex flex-wrap gap-3 justify-center">
          {children.map((m) => (
            <FamilyMemberCard
              key={m.id}
              member={m}
              linkedAgents={memberAgentMap.get(m.id) || []}
            />
          ))}
        </div>
      )}

      {members.length === 0 && (
        <p className="text-sm" style={{ color: C.textMuted }}>
          No family members yet.{" "}
          <Link to="/onboarding" className="underline" style={{ color: C.burgundy }}>
            Set up your household
          </Link>
          .
        </p>
      )}
    </section>
  );
}

// ── Zone 2: Personal Agents ───────────────────────────────────────

function PersonalAgentCard({
  agent,
  assignedMembers,
}: {
  agent: StaffAgent;
  assignedMembers: string[];
}) {
  const isButler = agent.isHeadButler;
  const incomplete = isSetupIncomplete(agent);

  return (
    <Link
      to={`/staff/${agent.id}`}
      className="block rounded-lg px-4 py-3 text-center transition-shadow hover:shadow-md"
      data-agent-id={agent.id}
      style={{
        border: isButler ? `2px solid ${C.headButlerBorder}` : `1.5px solid ${C.border}`,
        background: isButler ? C.headButlerBg : C.cardBg,
        minWidth: isButler ? "160px" : "140px",
      }}
    >
      {/* Name */}
      <div
        className={cn("font-semibold", isButler ? "text-[15px]" : "text-sm")}
        style={{ color: C.navy }}
      >
        {agent.name}
      </div>

      {/* Role badge + status dot */}
      <div className="flex items-center justify-center gap-2 mt-1.5">
        <Badge
          variant="secondary"
          className="text-[10px] px-2 py-0"
          style={{
            background: isButler ? C.burgundy : undefined,
            color: isButler ? "#fff" : undefined,
            borderColor: isButler ? C.burgundy : undefined,
          }}
        >
          {formatStaffRole(agent.staffRole, agent.isHeadButler)}
        </Badge>
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: getStatusColor(agent.status) }}
          title={agent.status}
        />
      </div>

      {/* Setup incomplete badge */}
      {incomplete && (
        <div className="mt-1.5">
          <Badge variant="warning" className="text-[9px] px-1.5 py-0">
            Setup incomplete
          </Badge>
        </div>
      )}

      {/* Assigned members */}
      {assignedMembers.length > 0 && (
        <div
          className="text-[10px] mt-1.5 italic"
          style={{ color: C.textFaint }}
        >
          {isButler ? "Manages the household" : assignedMembers.join(", ")}
        </div>
      )}
    </Link>
  );
}

function ConnectionLine({
  agentId,
  memberIds,
  allMemberElements,
  agentElement,
}: {
  agentId: string;
  memberIds: string[];
  allMemberElements: Map<string, DOMRect>;
  agentElement: DOMRect | null;
}) {
  // CSS-based connection indicators (not SVG).
  // We render small vertical dashes above each agent card that "point" upward.
  // The actual connection is shown by the assignment text on the cards.
  // This is intentionally simple for MVP.
  void agentId;
  void memberIds;
  void allMemberElements;
  void agentElement;
  return null;
}

function PersonalAgentsZone({
  agents,
  agentMemberMap,
}: {
  agents: StaffAgent[];
  agentMemberMap: Map<string, string[]>;
}) {
  // Sort: head butler first
  const sorted = [...agents].sort((a, b) => {
    if (a.isHeadButler && !b.isHeadButler) return -1;
    if (!a.isHeadButler && b.isHeadButler) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h3
          className="text-sm font-semibold tracking-wide"
          style={{ color: C.navy, letterSpacing: "0.5px" }}
        >
          Personal Agents
        </h3>
        <span
          className="text-[10px] uppercase tracking-[2px]"
          style={{ color: C.textMuted }}
        >
          {agents.length} agents
        </span>
      </div>

      {/* Upward connection indicators */}
      <div className="flex justify-center mb-1">
        <div className="flex gap-3 flex-wrap justify-center">
          {sorted.map((agent) => (
            <div key={agent.id} className="flex flex-col items-center">
              {/* Vertical connector dash */}
              <div
                className="w-px h-4 mb-1"
                style={{ background: C.border }}
              />
              <PersonalAgentCard
                agent={agent}
                assignedMembers={agentMemberMap.get(agent.id) || []}
              />
            </div>
          ))}
        </div>
      </div>

      {agents.length === 0 && (
        <p className="text-sm" style={{ color: C.textMuted }}>
          No personal agents yet.{" "}
          <a href="/household" className="underline" style={{ color: C.burgundy }}>Create your first agent</a> to get started.
        </p>
      )}
    </section>
  );
}

// ── Zone 3: Internal Agents ───────────────────────────────────────

function InternalAgentCard({ agent }: { agent: StaffAgent }) {
  const incomplete = isSetupIncomplete(agent);
  const isWorking = agent.status === "active";

  return (
    <Link
      to={`/staff/${agent.id}`}
      className="block rounded-lg px-4 py-3 text-center min-w-[130px] transition-shadow hover:shadow-md"
      style={{
        border: `1.5px dashed ${C.border}`,
        background: C.cardBg,
      }}
    >
      <div className="text-sm font-semibold" style={{ color: C.navy }}>
        {agent.name}
      </div>

      <div className="flex items-center justify-center gap-2 mt-1.5">
        <Badge
          variant="outline"
          className="text-[10px] px-2 py-0"
          style={{ borderColor: C.textFaint, color: C.textSecondary }}
        >
          {formatStaffRole(agent.staffRole, agent.isHeadButler)}
        </Badge>
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: getStatusColor(agent.status) }}
          title={agent.status}
        />
      </div>

      {incomplete && (
        <div className="mt-1.5">
          <Badge variant="warning" className="text-[9px] px-1.5 py-0">
            Setup incomplete
          </Badge>
        </div>
      )}

      {isWorking && (
        <div className="mt-2">
          <Progress value={60} max={100} className="h-1" />
          <div className="text-[9px] mt-0.5" style={{ color: C.textFaint }}>
            Working...
          </div>
        </div>
      )}
    </Link>
  );
}

function InternalAgentsZone({ agents }: { agents: StaffAgent[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <section>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full text-left py-2 group"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4" style={{ color: C.textMuted }} />
        ) : (
          <ChevronRight className="h-4 w-4" style={{ color: C.textMuted }} />
        )}
        <h3
          className="text-sm font-semibold tracking-wide"
          style={{ color: C.navy, letterSpacing: "0.5px" }}
        >
          Internal Staff
        </h3>
        <span
          className="text-[10px] uppercase tracking-[2px]"
          style={{ color: C.textMuted }}
        >
          {agents.length} agent{agents.length !== 1 ? "s" : ""}
        </span>
      </button>

      {expanded && (
        <div className="flex flex-wrap gap-3 justify-center pt-2 pb-1">
          {agents.map((agent) => (
            <InternalAgentCard key={agent.id} agent={agent} />
          ))}
          {agents.length === 0 && (
            <p className="text-sm" style={{ color: C.textMuted }}>
              No internal staff yet. Create specialist agents (tutor, coach, scheduler) from the{" "}
              <a href="/household" className="underline" style={{ color: C.burgundy }}>Household page</a>.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ── Activity Feed ─────────────────────────────────────────────────

function ActivityItem({ entry }: { entry: ActivityEntry }) {
  return (
    <div className="py-2 text-xs" style={{ borderBottom: `1px solid ${C.borderLight}` }}>
      <span style={{ color: C.textFaint }}>{formatTime(entry.createdAt)}</span>
      {" \u00B7 "}
      {entry.agentName && (
        <span className="font-semibold" style={{ color: C.burgundy }}>
          {entry.agentName}
        </span>
      )}{" "}
      <span style={{ color: C.textPrimary }}>{entry.action}</span>
      {entry.policyClause && (
        <span
          className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded"
          style={{ background: "#fff3e0", color: C.burgundy }}
        >
          {entry.policyClause}
        </span>
      )}
    </div>
  );
}

// ── Active Projects ───────────────────────────────────────────────

interface ProjectGroup {
  parentTask: Task;
  subtasks: Task[];
  agentName: string;
}

function buildProjects(tasks: Task[], staff: StaffAgent[]): ProjectGroup[] {
  const agentNameMap = new Map(staff.map((s) => [s.id, s.name]));

  // Find parent tasks (tasks that have children)
  const parentIds = new Set(
    tasks.filter((t) => t.parentTaskId).map((t) => t.parentTaskId!),
  );

  // Build groups for active projects
  const groups: ProjectGroup[] = [];
  for (const parentId of parentIds) {
    const parent = tasks.find((t) => t.id === parentId);
    if (!parent) continue;
    // Skip completed/failed parents
    if (parent.status === "completed" || parent.status === "failed") continue;

    const subtasks = tasks.filter((t) => t.parentTaskId === parentId);
    groups.push({
      parentTask: parent,
      subtasks,
      agentName: agentNameMap.get(parent.agentId) || "Unknown",
    });
  }

  return groups;
}

function ProjectCard({ project }: { project: ProjectGroup }) {
  const [expanded, setExpanded] = useState(false);
  const completedCount = project.subtasks.filter(
    (t) => t.status === "completed",
  ).length;
  const totalCount = project.subtasks.length;
  const progressPct = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;

  return (
    <div
      className="rounded-md p-3 mb-2"
      style={{ border: `1px solid ${C.borderLight}`, background: C.cardBg }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-start gap-2 w-full text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: C.textMuted }} />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: C.textMuted }} />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium" style={{ color: C.textPrimary }}>
            {project.parentTask.title}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[11px]" style={{ color: C.textMuted }}>
              {project.agentName}
            </span>
            <span className="text-[11px]" style={{ color: C.textFaint }}>
              {completedCount}/{totalCount} done
            </span>
          </div>
          <Progress value={progressPct} max={100} className="h-1 mt-1.5" />
        </div>
      </button>

      {expanded && (
        <div className="ml-5 mt-2 space-y-1">
          {project.subtasks.map((sub) => (
            <div key={sub.id} className="flex items-center gap-2 text-[12px]">
              <SubtaskStatusDot status={sub.status} />
              <span style={{ color: C.textPrimary }}>{sub.title}</span>
              <TaskStatusBadge status={sub.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SubtaskStatusDot({ status }: { status: string }) {
  const color =
    status === "completed"
      ? C.statusActive
      : status === "in_progress"
        ? "#3b82f6"
        : status === "failed"
          ? "#ef4444"
          : C.textFaint;

  return (
    <span
      className="w-1.5 h-1.5 rounded-full shrink-0"
      style={{ background: color }}
    />
  );
}

// ── Shared: Task Status Badge ─────────────────────────────────────

const TASK_STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  pending: { bg: "#fff3e0", text: "#8b6f4e" },
  approved: { bg: "#e8f5e9", text: "#2e7d32" },
  in_progress: { bg: "#e3f2fd", text: "#1565c0" },
  completed: { bg: "#e8f5e9", text: "#2e7d32" },
  failed: { bg: "#fce4ec", text: "#c62828" },
  cancelled: { bg: "#f5f5f5", text: "#757575" },
};

function TaskStatusBadge({ status }: { status: string }) {
  const style = TASK_STATUS_STYLES[status] || TASK_STATUS_STYLES.pending;
  const label = status.replace(/_/g, " ");
  return (
    <span
      className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full tracking-wide uppercase whitespace-nowrap"
      style={{ background: style.bg, color: style.text }}
    >
      {label}
    </span>
  );
}

// ── Dashboard Page ────────────────────────────────────────────────

export function DashboardPage() {
  // ── Data fetching ──────────────────────────────────────────────

  const { data: householdData } = useQuery<HouseholdData>({
    queryKey: ["household"],
    queryFn: () => api.get("/households/current"),
    retry: false,
  });

  const { data: staffData } = useQuery<{ staff: StaffAgent[] }>({
    queryKey: ["staff"],
    queryFn: () => api.get("/staff"),
    retry: false,
  });

  const householdId = householdData?.household?.id;

  const { data: tasksData } = useQuery<{ tasks: Task[] }>({
    queryKey: ["tasks", "dashboard", householdId],
    queryFn: () => api.get(`/tasks?householdId=${householdId}`),
    enabled: !!householdId,
    retry: false,
  });

  const { data: activityData } = useQuery<{ activity: ActivityEntry[] }>({
    queryKey: ["activity", "dashboard"],
    queryFn: () => api.get("/activity?limit=15"),
    retry: false,
  });

  // ── Derived data ──────────────────────────────────────────────

  const members = householdData?.members || [];
  const staff = staffData?.staff || [];
  const tasks = tasksData?.tasks || [];
  const activity = activityData?.activity || [];
  const householdName = householdData?.household?.name || "Household";

  const checklist = householdData?.checklist;
  const familyAgents = staff.filter((s) => s.visibility === "family");
  const internalAgents = staff.filter((s) => s.visibility === "internal");
  const memberAgentMap = buildMemberAgentMap(familyAgents);
  const agentMemberMap = buildAgentMemberMap(staff);
  const projects = buildProjects(tasks, staff);

  // ── Render ────────────────────────────────────────────────────

  return (
    <div className="p-6 lg:p-8 max-w-7xl">
      {/* Page header */}
      <div className="mb-6">
        <h2
          className="text-[22px] font-normal"
          style={{ color: C.navy, fontFamily: C.serif }}
        >
          {householdName}
        </h2>
        <p className="text-[13px] mt-1" style={{ color: C.textSecondary }}>
          {members.length} family member{members.length !== 1 ? "s" : ""} &middot;{" "}
          {familyAgents.length} personal agent{familyAgents.length !== 1 ? "s" : ""} &middot;{" "}
          {internalAgents.length} internal staff
        </p>
      </div>

      {/* Onboarding checklist */}
      {checklist && <OnboardingChecklist checklist={checklist} />}

      {/* Main layout: zones left, sidebar right */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* ── Left column: Three zones ─────────────────────────── */}
        <div className="space-y-5">
          {/* Zone 1: Family */}
          <Card className="border" style={{ borderColor: C.border }}>
            <CardContent className="p-5">
              <FamilyZone members={members} memberAgentMap={memberAgentMap} />
            </CardContent>
          </Card>

          {/* Zone 2: Personal Agents */}
          <Card className="border" style={{ borderColor: C.border }}>
            <CardContent className="p-5">
              <PersonalAgentsZone
                agents={familyAgents}
                agentMemberMap={agentMemberMap}
              />
            </CardContent>
          </Card>

          {/* Zone 3: Internal Agents (collapsible) */}
          <Card className="border" style={{ borderColor: C.border }}>
            <CardContent className="p-5 pb-3">
              <InternalAgentsZone agents={internalAgents} />
            </CardContent>
          </Card>
        </div>

        {/* ── Right column: Activity + Projects ────────────────── */}
        <div className="space-y-5">
          {/* Activity feed */}
          <Card className="border" style={{ borderColor: C.border }}>
            <CardContent className="p-5">
              <h3
                className="text-sm font-semibold mb-3 tracking-wide"
                style={{ color: C.navy, letterSpacing: "0.5px" }}
              >
                Recent Activity
              </h3>
              {activity.length > 0 ? (
                <div>
                  {activity.map((entry) => (
                    <ActivityItem key={entry.id} entry={entry} />
                  ))}
                </div>
              ) : (
                <p className="text-sm" style={{ color: C.textMuted }}>
                  Activity will appear when agents start working.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Active projects */}
          <Card className="border" style={{ borderColor: C.border }}>
            <CardContent className="p-5">
              <h3
                className="text-sm font-semibold mb-3 tracking-wide"
                style={{ color: C.navy, letterSpacing: "0.5px" }}
              >
                Active Projects
              </h3>
              {projects.length > 0 ? (
                <div>
                  {projects.map((p) => (
                    <ProjectCard key={p.parentTask.id} project={p} />
                  ))}
                </div>
              ) : (
                <p className="text-sm" style={{ color: C.textMuted }}>
                  Projects appear when agents delegate work to specialists.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
