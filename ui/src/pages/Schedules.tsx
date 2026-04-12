import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import {
  Clock,
  Plus,
  X,
  Pencil,
  Trash2,
  Play,
  Pause,
  Check,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  agentId: string;
  agentName?: string;
  memberId?: string | null;
  scheduleType: string;
  scheduleValue: string;
  timezone: string;
  enabled: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  runCount: number;
}

interface StaffAgent {
  id: string;
  name: string;
}

interface HouseholdMember {
  id: string;
  name: string;
  role: string;
}

interface HouseholdData {
  household: { id: string; name: string };
  members: HouseholdMember[];
}

// ── Helpers ────────────────────────────────────────────────────────

function formatSchedule(type: string, value: string): string {
  if (type === "interval") return `Every ${value}`;
  if (type === "once") {
    try { return `Once at ${new Date(value).toLocaleString()}`; } catch { return value; }
  }
  // Cron — show human-readable for common patterns
  const parts = value.split(" ");
  if (parts.length === 5) {
    const [min, hour] = parts;
    if (parts[2] === "*" && parts[3] === "*" && parts[4] === "*") {
      if (hour !== "*" && min !== "*") {
        const h = parseInt(hour, 10);
        const m = parseInt(min, 10);
        const ampm = h >= 12 ? "PM" : "AM";
        const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
        return `Daily at ${displayH}:${m.toString().padStart(2, "0")} ${ampm}`;
      }
      if (hour === "*") return `Every hour at :${min.padStart(2, "0")}`;
    }
  }
  return value;
}

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const absDiff = Math.abs(diffMs);
  const past = diffMs < 0;

  if (absDiff < 60_000) return past ? "just now" : "in < 1m";
  if (absDiff < 3_600_000) {
    const m = Math.round(absDiff / 60_000);
    return past ? `${m}m ago` : `in ${m}m`;
  }
  if (absDiff < 86_400_000) {
    const h = Math.round(absDiff / 3_600_000);
    return past ? `${h}h ago` : `in ${h}h`;
  }
  const d = Math.round(absDiff / 86_400_000);
  return past ? `${d}d ago` : `in ${d}d`;
}

function statusColor(status: string | null | undefined): string {
  if (status === "success") return "#2e7d32";
  if (status === "error") return "#c62828";
  if (status === "blocked") return "#b8860b";
  return "#8a8070";
}

// ── Schedule Editor ────────────────────────────────────────────────

function ScheduleEditor({
  scheduleType,
  scheduleValue,
  onTypeChange,
  onValueChange,
}: {
  scheduleType: string;
  scheduleValue: string;
  onTypeChange: (v: string) => void;
  onValueChange: (v: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Type</label>
        <Select value={scheduleType} onValueChange={onTypeChange}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="cron">Cron (e.g., daily at 6am)</SelectItem>
            <SelectItem value="interval">Interval (e.g., every 2h)</SelectItem>
            <SelectItem value="once">One-time</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>
          {scheduleType === "cron" ? "Cron expression" : scheduleType === "interval" ? "Interval" : "Run at"}
        </label>
        <Input
          value={scheduleValue}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={
            scheduleType === "cron" ? "0 6 * * *" :
            scheduleType === "interval" ? "24h" :
            "2026-04-15T09:00"
          }
          style={{ fontFamily: "monospace", fontSize: "12px" }}
        />
        {scheduleType === "cron" && (
          <p className="text-[10px] mt-1" style={{ color: "#a09080" }}>
            min hour day month weekday (e.g., 0 6 * * * = daily 6am, 0 9 * * 1 = Mondays 9am)
          </p>
        )}
      </div>
    </div>
  );
}

// ── Task Row ───────────────────────────────────────────────────────

function TaskRow({
  task,
  agents,
  members,
  householdId,
}: {
  task: ScheduledTask;
  agents: StaffAgent[];
  members: HouseholdMember[];
  householdId: string;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(task.name);
  const [prompt, setPrompt] = useState(task.prompt);
  const [scheduleType, setScheduleType] = useState(task.scheduleType);
  const [scheduleValue, setScheduleValue] = useState(task.scheduleValue);
  const [agentId, setAgentId] = useState(task.agentId);

  const toggleMutation = useMutation({
    mutationFn: () => api.post(`/scheduled-tasks/${task.id}/toggle`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] }),
  });

  const updateMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.put(`/scheduled-tasks/${task.id}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
      setEditing(false);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/scheduled-tasks/${task.id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] }),
  });

  if (editing) {
    return (
      <Card className="border-2" style={{ borderColor: "#8b6f4e" }}>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium" style={{ color: "#1a1f2e" }}>Edit Schedule</span>
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => {
                updateMutation.mutate({ name, prompt, scheduleType, scheduleValue, agentId });
              }}>
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Task name" />
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do?"
            rows={3}
            style={{ fontSize: "13px" }}
          />
          <ScheduleEditor
            scheduleType={scheduleType}
            scheduleValue={scheduleValue}
            onTypeChange={setScheduleType}
            onValueChange={setScheduleValue}
          />
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className="border hover:shadow-sm transition-shadow"
      style={{ borderColor: "#ddd5c8", opacity: task.enabled ? 1 : 0.5 }}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium" style={{ color: "#1a1f2e" }}>{task.name}</span>
              {!task.enabled && (
                <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "#f0ede6", color: "#8a8070" }}>
                  paused
                </span>
              )}
            </div>
            <p className="text-xs mt-0.5" style={{ color: "#8a8070" }}>
              {task.agentName ?? "Unknown agent"}
            </p>
          </div>
          <div className="flex gap-1 shrink-0">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => toggleMutation.mutate()}>
              {task.enabled ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(true)}>
              <Pencil className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-500" onClick={() => deleteMutation.mutate()}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Schedule + timing */}
        <div className="flex items-center gap-4 text-xs mb-2" style={{ color: "#8a8070" }}>
          <span className="font-mono">{formatSchedule(task.scheduleType, task.scheduleValue)}</span>
          {task.nextRunAt && task.enabled && (
            <span>Next: {formatRelativeTime(task.nextRunAt)}</span>
          )}
          {task.lastRunAt && (
            <span style={{ color: statusColor(task.lastStatus) }}>
              Last: {formatRelativeTime(task.lastRunAt)} ({task.lastStatus ?? "—"})
            </span>
          )}
        </div>

        {/* Prompt preview */}
        <p className="text-xs line-clamp-2" style={{ color: "#5a5a5a" }}>{task.prompt}</p>

        {task.lastError && (
          <p className="text-[10px] mt-2 p-2 rounded" style={{ background: "#fef2f2", color: "#c62828" }}>
            {task.lastError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Add Task Modal ─────────────────────────────────────────────────

function AddTaskModal({
  householdId,
  agents,
  members,
  onClose,
}: {
  householdId: string;
  agents: StaffAgent[];
  members: HouseholdMember[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [memberId, setMemberId] = useState("");
  const [scheduleType, setScheduleType] = useState("cron");
  const [scheduleValue, setScheduleValue] = useState("0 6 * * *");
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post("/scheduled-tasks", payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["scheduled-tasks"] });
      onClose();
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!name.trim() || !prompt.trim()) return;

    mutation.mutate({
      householdId,
      agentId,
      memberId: memberId || null,
      name: name.trim(),
      prompt: prompt.trim(),
      scheduleType,
      scheduleValue,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="rounded-lg shadow-xl w-full max-w-lg mx-4"
        style={{ background: "#faf6ef", border: "1px solid #ddd5c8" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "#eee8dd" }}>
          <h3 className="text-base font-medium" style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}>
            New Scheduled Task
          </h3>
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Name</label>
            <Input
              placeholder="e.g., Daily briefing"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              style={submitted && !name.trim() ? { borderColor: "#c62828" } : undefined}
            />
          </div>

          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Prompt</label>
            <Textarea
              placeholder="What should the agent do? e.g., Give me a morning briefing: what's on my calendar today, any pending commitments, and anything I should know about."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              style={submitted && !prompt.trim() ? { borderColor: "#c62828" } : undefined}
            />
          </div>

          <ScheduleEditor
            scheduleType={scheduleType}
            scheduleValue={scheduleValue}
            onTypeChange={setScheduleType}
            onValueChange={setScheduleValue}
          />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Agent</label>
              <Select value={agentId} onValueChange={setAgentId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>Run as</label>
              <Select value={memberId} onValueChange={setMemberId}>
                <SelectTrigger><SelectValue placeholder="Select member..." /></SelectTrigger>
                <SelectContent>
                  {members.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={mutation.isPending} style={{ background: "#1a1f2e", color: "#e8dfd0" }}>
              {mutation.isPending ? "Creating..." : "Create"}
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

// ── Page ───────────────────────────────────────────────────────────

export function SchedulesPage() {
  const [showAdd, setShowAdd] = useState(false);

  const { data: householdData } = useQuery<HouseholdData>({
    queryKey: ["household"],
    queryFn: () => api.get("/households/current"),
  });

  const householdId = householdData?.household?.id;

  const { data: staffData } = useQuery<{ staff: StaffAgent[] }>({
    queryKey: ["staff"],
    queryFn: () => api.get("/staff"),
  });

  const { data: taskData, isLoading } = useQuery<{ scheduledTasks: ScheduledTask[] }>({
    queryKey: ["scheduled-tasks"],
    queryFn: () => api.get(`/scheduled-tasks?householdId=${householdId}`),
    enabled: !!householdId,
    refetchInterval: 30_000, // Refresh every 30s to update relative times
  });

  const agents = staffData?.staff ?? [];
  const members = householdData?.members ?? [];
  const tasks = taskData?.scheduledTasks ?? [];
  const enabledTasks = tasks.filter((t) => t.enabled);
  const disabledTasks = tasks.filter((t) => !t.enabled);

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5" style={{ color: "#8a8070" }} />
            <h2
              className="text-[22px] font-normal"
              style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              Scheduled Tasks
            </h2>
          </div>
          <p className="text-[13px] mt-1" style={{ color: "#7a7060" }}>
            {tasks.length} task{tasks.length !== 1 ? "s" : ""}
            {enabledTasks.length > 0 && ` (${enabledTasks.length} active)`}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setShowAdd(true)}
          disabled={!householdId}
          style={{ background: "#1a1f2e", color: "#e8dfd0" }}
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Task
        </Button>
      </div>

      {isLoading && (
        <p className="text-sm" style={{ color: "#8a8070" }}>Loading...</p>
      )}

      {!isLoading && tasks.length === 0 && (
        <Card className="border" style={{ borderColor: "#ddd5c8" }}>
          <CardContent className="p-8 text-center">
            <Clock className="h-8 w-8 mx-auto mb-3" style={{ color: "#ddd5c8" }} />
            <p className="text-sm mb-1" style={{ color: "#8a8070" }}>
              No scheduled tasks yet.
            </p>
            <p className="text-xs" style={{ color: "#a09080" }}>
              Create recurring tasks like daily briefings, weekly meal plans, or homework reminders.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {enabledTasks.map((task) => (
          <TaskRow key={task.id} task={task} agents={agents} members={members} householdId={householdId!} />
        ))}
        {disabledTasks.length > 0 && enabledTasks.length > 0 && (
          <p className="text-xs font-medium uppercase tracking-wider pt-4 pb-1" style={{ color: "#8a8070" }}>
            Paused
          </p>
        )}
        {disabledTasks.map((task) => (
          <TaskRow key={task.id} task={task} agents={agents} members={members} householdId={householdId!} />
        ))}
      </div>

      {showAdd && householdId && (
        <AddTaskModal
          householdId={householdId}
          agents={agents}
          members={members}
          onClose={() => setShowAdd(false)}
        />
      )}
    </div>
  );
}
