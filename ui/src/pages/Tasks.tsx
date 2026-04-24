import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  ListTodo,
  CheckCircle2,
  Clock,
  AlertCircle,
  XCircle,
  Play,
  ChevronDown,
  ChevronUp,
  ThumbsUp,
  X,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

type TaskStatus = "pending" | "approved" | "in_progress" | "completed" | "failed" | "cancelled";

interface TaskEvent {
  id: string;
  type: string;
  description?: string;
  createdAt: string;
}

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  agentId: string;
  agentName?: string;
  requestedBy?: string;
  /** Resolved family member name for `requestedBy`. v0.4 server enriches
   * this on GET /tasks so the UI can show "Requested by Josh" instead of
   * a raw memberId UUID. */
  requestedByName?: string;
  governingClauses?: string[];
  result?: string;
  report?: string;
  description?: string;
  events?: TaskEvent[];
  createdAt: string;
  updatedAt?: string;
}

interface HireProposalMeta {
  kind: "hire_proposal";
  role?: string;
  specialty?: string;
  reason?: string;
  proposedName?: string;
  customInstructions?: string;
  model?: string;
  trustLevel?: "full" | "standard" | "restricted";
  originalUserRequest?: string;
}

function parseHireProposal(description: string | undefined): HireProposalMeta | null {
  if (!description) return null;
  try {
    const parsed = JSON.parse(description) as { kind?: string } & HireProposalMeta;
    if (parsed.kind !== "hire_proposal") return null;
    return parsed as HireProposalMeta;
  } catch {
    return null;
  }
}

interface StaffAgent {
  id: string;
  name: string;
  staffRole: string;
}

interface HouseholdMember {
  id: string;
  name: string;
}

interface HouseholdData {
  household: { id: string; name: string };
  members: HouseholdMember[];
}

// ── Constants ──────────────────────────────────────────────────────

const STATUS_CONFIG: Record<TaskStatus, { bg: string; text: string; icon: React.ComponentType<{ className?: string }> }> = {
  pending: { bg: "#fff3e0", text: "#8b6f4e", icon: Clock },
  approved: { bg: "#e8f5e9", text: "#2e7d32", icon: ThumbsUp },
  in_progress: { bg: "#e3f2fd", text: "#1565c0", icon: Play },
  completed: { bg: "#e8f5e9", text: "#2e7d32", icon: CheckCircle2 },
  failed: { bg: "#fce4ec", text: "#c62828", icon: XCircle },
  cancelled: { bg: "#f5f5f5", text: "#757575", icon: X },
};

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All Statuses" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

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

// ── Task Card ──────────────────────────────────────────────────────

function TaskCard({ task, onSelect }: { task: Task; onSelect: () => void }) {
  const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const StatusIcon = config.icon;

  return (
    <button
      onClick={onSelect}
      className="w-full text-left"
    >
      <Card
        className="border hover:shadow-sm transition-shadow cursor-pointer"
        style={{ borderColor: "#ddd5c8" }}
      >
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <span
              className="flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-full uppercase tracking-wide whitespace-nowrap shrink-0 mt-0.5"
              style={{ background: config.bg, color: config.text }}
            >
              <StatusIcon className="h-3 w-3" />
              {task.status.replace(/_/g, " ")}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" style={{ color: "#1a1f2e" }}>
                {task.title}
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: "#8a8070" }}>
                {task.agentName || "Unknown agent"}
                {task.requestedByName
                  ? ` \u00B7 Requested by ${task.requestedByName}`
                  : task.requestedBy
                  ? ` \u00B7 Requested by ${task.requestedBy.slice(0, 8)}…`
                  : ""}
                {" \u00B7 "}
                {relativeTime(task.createdAt)}
              </p>
              {task.governingClauses && task.governingClauses.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {task.governingClauses.map((clause, i) => (
                    <span
                      key={i}
                      className="text-[9px] px-1.5 py-0.5 rounded italic"
                      style={{ background: "#fff3e0", color: "#a09080" }}
                    >
                      {clause}
                    </span>
                  ))}
                </div>
              )}
              {task.result && (
                <p className="text-xs mt-1.5 truncate" style={{ color: "#6a6050" }}>
                  Result: {task.result}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </button>
  );
}

// ── Task Detail Panel ──────────────────────────────────────────────

function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const queryClient = useQueryClient();

  const { data: taskData, isLoading } = useQuery<{ task: Task }>({
    queryKey: ["task", taskId],
    queryFn: () => api.get(`/tasks/${taskId}`),
    enabled: !!taskId,
  });

  const approveMutation = useMutation({
    mutationFn: () => api.post(`/tasks/${taskId}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });

  // Dedicated mutations for hire_proposal tasks — these route through the
  // v0.4 DelegationService so the approval actually materializes a staff
  // agent + delegation edges (the v0.1 taskEngine.approveTask path just
  // flips the status and doesn't know about hiring).
  const approveHireMutation = useMutation<
    { ok: true; developerAgentId?: string; alreadyResolved?: boolean },
    Error
  >({
    mutationFn: () =>
      api.post(`/tasks/${taskId}/approve-hire`, { approvedBy: "web-ui" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      queryClient.invalidateQueries({ queryKey: ["staff"] });
    },
  });
  const rejectHireMutation = useMutation<
    { ok: true; alreadyResolved?: boolean },
    Error
  >({
    mutationFn: () =>
      api.post(`/tasks/${taskId}/reject-hire`, { rejectedBy: "web-ui" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
      queryClient.invalidateQueries({ queryKey: ["task", taskId] });
    },
  });

  const task = taskData?.task;

  if (isLoading) {
    return (
      <Card className="border" style={{ borderColor: "#ddd5c8" }}>
        <CardContent className="p-5">
          <p className="text-sm" style={{ color: "#8a8070" }}>Loading task...</p>
        </CardContent>
      </Card>
    );
  }

  if (!task) return null;

  const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const StatusIcon = config.icon;

  return (
    <Card className="border" style={{ borderColor: "#ddd5c8" }}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold" style={{ color: "#1a1f2e" }}>
              {task.title}
            </h3>
            <div className="flex items-center gap-2 mt-1">
              <span
                className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-full uppercase"
                style={{ background: config.bg, color: config.text }}
              >
                <StatusIcon className="h-3 w-3" />
                {task.status.replace(/_/g, " ")}
              </span>
              <span className="text-xs" style={{ color: "#8a8070" }}>
                {task.agentName}
              </span>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-3 mb-4 text-xs" style={{ color: "#8a8070" }}>
          <div>
            <span className="text-[10px] uppercase tracking-wider block mb-0.5">Requested by</span>
            <span style={{ color: "#2c2c2c" }}>
              {task.requestedByName ?? (task.requestedBy ? `${task.requestedBy.slice(0, 8)}…` : "System")}
            </span>
          </div>
          <div>
            <span className="text-[10px] uppercase tracking-wider block mb-0.5">Created</span>
            <span style={{ color: "#2c2c2c" }}>{formatTime(task.createdAt)}</span>
          </div>
          {task.updatedAt && (
            <div>
              <span className="text-[10px] uppercase tracking-wider block mb-0.5">Updated</span>
              <span style={{ color: "#2c2c2c" }}>{formatTime(task.updatedAt)}</span>
            </div>
          )}
        </div>

        {/* Governing clauses */}
        {task.governingClauses && task.governingClauses.length > 0 && (
          <div className="mb-4">
            <span className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: "#8a8070" }}>
              Governing Clauses
            </span>
            <div className="flex flex-wrap gap-1">
              {task.governingClauses.map((c, i) => (
                <span
                  key={i}
                  className="text-[10px] px-2 py-0.5 rounded italic"
                  style={{ background: "#fff3e0", color: "#8b6f4e" }}
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Result */}
        {task.result && (
          <div className="mb-4">
            <span className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: "#8a8070" }}>
              Result
            </span>
            <div
              className="text-sm p-3 rounded whitespace-pre-wrap"
              style={{ background: "#faf8f4", color: "#2c2c2c" }}
            >
              {task.result}
            </div>
          </div>
        )}

        {/* Report */}
        {task.report && (
          <div className="mb-4">
            <span className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: "#8a8070" }}>
              Report
            </span>
            <div
              className="text-sm p-3 rounded whitespace-pre-wrap"
              style={{ background: "#faf8f4", color: "#2c2c2c" }}
            >
              {task.report}
            </div>
          </div>
        )}

        {/* Event timeline */}
        {task.events && task.events.length > 0 && (
          <div className="mb-4">
            <span className="text-[10px] uppercase tracking-wider block mb-2" style={{ color: "#8a8070" }}>
              Timeline
            </span>
            <div className="space-y-2">
              {task.events.map((event) => (
                <div
                  key={event.id}
                  className="flex gap-3 text-xs"
                >
                  <span className="shrink-0" style={{ color: "#a09080" }}>
                    {formatTime(event.createdAt)}
                  </span>
                  <div>
                    <span className="font-medium" style={{ color: "#1a1f2e" }}>
                      {event.type.replace(/_/g, " ")}
                    </span>
                    {event.description && (
                      <span style={{ color: "#8a8070" }}> - {event.description}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Approve action — hire proposals route through the v0.4 flow;
            everything else uses the v0.1 taskEngine approve path. */}
        {task.status === "pending" && (() => {
          const hire = parseHireProposal(task.description);
          if (hire) {
            const errMsg =
              (approveHireMutation.error?.message) ||
              (rejectHireMutation.error?.message);
            return (
              <div className="pt-3 border-t" style={{ borderColor: "#eee8dd" }}>
                <div
                  className="mb-3 p-3 rounded text-xs"
                  style={{ background: "#faf6ed", color: "#5a4a2e" }}
                >
                  <div className="font-semibold mb-1" style={{ color: "#1a1f2e" }}>
                    Hire: {hire.proposedName ?? "a new specialist"}
                    {hire.role ? ` — ${hire.role}` : ""}
                  </div>
                  <div className="mb-1">
                    <span className="uppercase tracking-wider text-[10px]" style={{ color: "#8a8070" }}>Specialty</span>{" "}
                    <code>{hire.specialty ?? "general"}</code>
                  </div>
                  {hire.reason && (
                    <div className="mb-1">
                      <span className="uppercase tracking-wider text-[10px]" style={{ color: "#8a8070" }}>Reason</span>{" "}
                      {hire.reason}
                    </div>
                  )}
                  {hire.customInstructions && (
                    <div className="mb-1">
                      <span className="uppercase tracking-wider text-[10px]" style={{ color: "#8a8070" }}>Custom operating instructions</span>
                      <pre
                        className="mt-1 p-2 text-[11px] whitespace-pre-wrap rounded"
                        style={{ background: "#fff", border: "1px solid #e0d9c7", maxHeight: "12rem", overflowY: "auto" }}
                      >
                        {hire.customInstructions}
                      </pre>
                    </div>
                  )}
                  {hire.originalUserRequest && (
                    <div className="mb-1">
                      <span className="uppercase tracking-wider text-[10px]" style={{ color: "#8a8070" }}>Will auto-delegate</span>{" "}
                      <i>{hire.originalUserRequest}</i>
                    </div>
                  )}
                  <div>
                    <span className="uppercase tracking-wider text-[10px]" style={{ color: "#8a8070" }}>Model / trust</span>{" "}
                    {hire.model ?? "default"}, {hire.trustLevel ?? "default"}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => approveHireMutation.mutate()}
                    disabled={approveHireMutation.isPending || rejectHireMutation.isPending}
                    style={{ background: "#2e7d32", color: "#fff" }}
                  >
                    <ThumbsUp className="h-3.5 w-3.5 mr-1" />
                    {approveHireMutation.isPending ? "Approving..." : "Approve hire"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => rejectHireMutation.mutate()}
                    disabled={approveHireMutation.isPending || rejectHireMutation.isPending}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" />
                    {rejectHireMutation.isPending ? "Rejecting..." : "Reject"}
                  </Button>
                </div>
                {errMsg && (
                  <p className="text-xs mt-2" style={{ color: "#a82020" }}>
                    {errMsg}
                  </p>
                )}
              </div>
            );
          }
          // Non-hire pending task — original behavior.
          return (
            <div className="flex gap-2 pt-3 border-t" style={{ borderColor: "#eee8dd" }}>
              <Button
                size="sm"
                onClick={() => approveMutation.mutate()}
                disabled={approveMutation.isPending}
                style={{ background: "#2e7d32", color: "#fff" }}
              >
                <ThumbsUp className="h-3.5 w-3.5 mr-1" />
                {approveMutation.isPending ? "Approving..." : "Approve"}
              </Button>
            </div>
          );
        })()}
      </CardContent>
    </Card>
  );
}

// ── Tasks Page ─────────────────────────────────────────────────────

export function TasksPage() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [staffFilter, setStaffFilter] = useState("all");
  const [memberFilter, setMemberFilter] = useState("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const { data: staffData } = useQuery<{ staff: StaffAgent[] }>({
    queryKey: ["staff"],
    queryFn: () => api.get("/staff"),
    retry: false,
  });

  const { data: householdData } = useQuery<HouseholdData>({
    queryKey: ["household"],
    queryFn: () => api.get("/households/current"),
    retry: false,
  });

  const householdId = householdData?.household?.id;

  const queryParams = new URLSearchParams();
  if (householdId) queryParams.set("householdId", householdId);
  if (statusFilter !== "all") queryParams.set("status", statusFilter);
  if (staffFilter !== "all") queryParams.set("agentId", staffFilter);
  if (memberFilter !== "all") queryParams.set("memberId", memberFilter);
  const queryString = queryParams.toString();

  const { data: tasksData, isLoading } = useQuery<{ tasks: Task[] }>({
    queryKey: ["tasks", queryString],
    queryFn: () => api.get(`/tasks?${queryString}`),
    enabled: !!householdId,
  });

  const tasks = tasksData?.tasks || [];
  const staff = staffData?.staff || [];
  const members = householdData?.members || [];

  // Split pending tasks for approval queue
  const pendingTasks = tasks.filter((t) => t.status === "pending");
  const otherTasks = tasks.filter((t) => t.status !== "pending");

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <ListTodo className="h-5 w-5" style={{ color: "#8a8070" }} />
          <h2
            className="text-[22px] font-normal"
            style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            Tasks
          </h2>
        </div>
        <p className="text-[13px] mt-1" style={{ color: "#7a7060" }}>
          {tasks.length} task{tasks.length !== 1 ? "s" : ""}
          {pendingTasks.length > 0 ? ` \u00B7 ${pendingTasks.length} awaiting approval` : ""}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-[160px] text-xs" style={{ borderColor: "#ddd5c8" }}>
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={staffFilter} onValueChange={setStaffFilter}>
          <SelectTrigger className="h-8 w-[160px] text-xs" style={{ borderColor: "#ddd5c8" }}>
            <SelectValue placeholder="Staff Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Staff</SelectItem>
            {staff.map((s) => (
              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={memberFilter} onValueChange={setMemberFilter}>
          <SelectTrigger className="h-8 w-[160px] text-xs" style={{ borderColor: "#ddd5c8" }}>
            <SelectValue placeholder="Member" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Members</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Task list */}
        <div className={cn("space-y-3", selectedTaskId ? "lg:col-span-2" : "lg:col-span-3")}>
          {/* Approval queue */}
          {pendingTasks.length > 0 && statusFilter === "all" && (
            <div className="mb-4">
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-2" style={{ color: "#8b6f4e" }}>
                <AlertCircle className="h-4 w-4" />
                Awaiting Approval ({pendingTasks.length})
              </h3>
              <div className="space-y-2">
                {pendingTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onSelect={() => setSelectedTaskId(task.id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Other tasks */}
          {isLoading && (
            <p className="text-sm" style={{ color: "#8a8070" }}>Loading tasks...</p>
          )}

          {!isLoading && tasks.length === 0 && (
            <Card className="border" style={{ borderColor: "#ddd5c8" }}>
              <CardContent className="p-6 text-center">
                <ListTodo className="h-8 w-8 mx-auto mb-3" style={{ color: "#ddd5c8" }} />
                <p className="text-sm" style={{ color: "#8a8070" }}>
                  No tasks found. Staff agents will create tasks as they work.
                </p>
              </CardContent>
            </Card>
          )}

          {(statusFilter === "all" ? otherTasks : tasks).map((task) => {
            // Skip pending if we already showed them in the approval queue
            if (statusFilter === "all" && task.status === "pending") return null;
            return (
              <TaskCard
                key={task.id}
                task={task}
                onSelect={() => setSelectedTaskId(task.id)}
              />
            );
          })}
        </div>

        {/* Detail panel */}
        {selectedTaskId && (
          <div className="lg:col-span-1">
            <div className="sticky top-6">
              <TaskDetail
                taskId={selectedTaskId}
                onClose={() => setSelectedTaskId(null)}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
