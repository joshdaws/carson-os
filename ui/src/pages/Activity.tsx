import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, Wrench, ShieldAlert, FileX, ChevronDown, ChevronRight } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

interface PolicyDetails {
  conversationId?: string;
  taskId?: string;
  clauseId?: string;
  clauseText?: string;
  clauseCategory?: string;
  enforcementLevel?: string;
  context?: string;
}

interface ToolDetails {
  input?: unknown;
  result?: unknown;
}

interface RedactDetails {
  messageId?: string;
  reason?: string;
  originalLength?: number;
}

interface ActivityEntry {
  id: string;
  type: "activity" | "policy";
  action: string;
  agentId?: string;
  details: unknown;
  createdAt: string;
}

interface StaffAgent {
  id: string;
  name: string;
}

// ── Color palette ──────────────────────────────────────────────────

const C = {
  navy: "#1a1f2e",
  burgundy: "#8b6f4e",
  textPrimary: "#2c2c2c",
  textSecondary: "#6a6050",
  textMuted: "#8a8070",
  textFaint: "#a09080",
  border: "#ddd5c8",
  borderLight: "#eee8dd",
  serif: "Georgia, 'Times New Roman', serif",
} as const;

// ── Helpers ────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDateTime(dateStr: string): string {
  return new Date(dateStr).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatAction(action: string): string {
  if (action.startsWith("tool:")) return action.slice(5);
  return action.replace(/_/g, " ");
}

function getEntryMeta(entry: ActivityEntry) {
  if (entry.type === "policy") {
    const hard = (entry.details as PolicyDetails).enforcementLevel === "hard";
    return {
      Icon: ShieldAlert,
      iconColor: hard ? "#c62828" : "#b8860b",
      badgeBg: hard ? "#fce4ec" : "#fff3e0",
      badgeColor: hard ? "#c62828" : "#b8860b",
    };
  }
  if (entry.action === "redact_user_message") {
    return { Icon: FileX, iconColor: C.textMuted, badgeBg: null, badgeColor: null };
  }
  return { Icon: Wrench, iconColor: C.textMuted, badgeBg: null, badgeColor: null };
}

// ── Expanded detail views ──────────────────────────────────────────

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre
      className="text-[11px] rounded p-2 overflow-x-auto whitespace-pre-wrap break-words"
      style={{ background: "rgba(0,0,0,0.04)", color: C.textSecondary, maxHeight: "180px" }}
    >
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function FieldRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <p className="text-xs" style={{ color: C.textSecondary }}>
      <span style={{ color: C.textMuted }}>{label}: </span>
      {value}
    </p>
  );
}

function PolicyDetailView({ d }: { d: PolicyDetails }) {
  return (
    <div className="space-y-1.5">
      {d.clauseText && <FieldRow label="Clause" value={d.clauseText} />}
      {d.enforcementLevel && <FieldRow label="Level" value={d.enforcementLevel} />}
      {d.clauseCategory && <FieldRow label="Category" value={d.clauseCategory} />}
      {d.context && <FieldRow label="Context" value={d.context} />}
      {d.conversationId && (
        <FieldRow label="Conversation" value={<span className="font-mono text-[11px]">{d.conversationId}</span>} />
      )}
    </div>
  );
}

function RedactDetailView({ d }: { d: RedactDetails }) {
  return (
    <div className="space-y-1.5">
      {d.reason && <FieldRow label="Reason" value={d.reason} />}
      {d.originalLength !== undefined && <FieldRow label="Original length" value={`${d.originalLength} chars`} />}
      {d.messageId && (
        <FieldRow label="Message ID" value={<span className="font-mono text-[11px]">{d.messageId}</span>} />
      )}
    </div>
  );
}

function ToolDetailView({ d }: { d: ToolDetails }) {
  return (
    <div className="space-y-2">
      {d.input !== undefined && (
        <div>
          <p className="text-[10px] uppercase tracking-[1px] mb-1" style={{ color: C.textMuted }}>Input</p>
          <JsonBlock value={d.input} />
        </div>
      )}
      {d.result !== undefined && (
        <div>
          <p className="text-[10px] uppercase tracking-[1px] mb-1" style={{ color: C.textMuted }}>Result</p>
          <JsonBlock value={d.result} />
        </div>
      )}
    </div>
  );
}

// ── Activity Row ───────────────────────────────────────────────────

function ActivityRow({ entry, agentName }: { entry: ActivityEntry; agentName?: string }) {
  const [expanded, setExpanded] = useState(false);
  const { Icon, iconColor, badgeBg, badgeColor } = getEntryMeta(entry);
  const label = formatAction(entry.action);
  const hasDetails = !!entry.details;
  const policyDetails = entry.type === "policy" ? (entry.details as PolicyDetails) : null;

  return (
    <div className="py-3" style={{ borderBottom: `1px solid ${C.borderLight}` }}>
      <button
        className="flex items-start gap-3 w-full text-left"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        disabled={!hasDetails}
      >
        {/* Chevron column */}
        <div className="w-4 shrink-0 mt-0.5">
          {hasDetails && (
            expanded
              ? <ChevronDown className="h-3.5 w-3.5" style={{ color: C.textFaint }} />
              : <ChevronRight className="h-3.5 w-3.5" style={{ color: C.textFaint }} />
          )}
        </div>

        {/* Icon */}
        <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" style={{ color: iconColor }} />

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="text-[13px] font-medium" style={{ color: C.textPrimary }}>
                {label}
              </span>
              {badgeBg && (
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide whitespace-nowrap"
                  style={{ background: badgeBg, color: badgeColor ?? undefined }}
                >
                  {policyDetails?.enforcementLevel ?? entry.action}
                </span>
              )}
              {agentName && (
                <span className="text-[12px] shrink-0" style={{ color: C.burgundy }}>
                  {agentName}
                </span>
              )}
            </div>
            <span
              className="text-[11px] shrink-0"
              style={{ color: C.textFaint }}
              title={formatDateTime(entry.createdAt)}
            >
              {relativeTime(entry.createdAt)}
            </span>
          </div>

          {/* Policy clause preview when collapsed */}
          {!expanded && policyDetails?.clauseText && (
            <p className="text-xs mt-0.5 truncate" style={{ color: C.textMuted }}>
              {policyDetails.clauseText}
            </p>
          )}
        </div>
      </button>

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="ml-[44px] mt-2">
          {entry.type === "policy" ? (
            <PolicyDetailView d={entry.details as PolicyDetails} />
          ) : entry.action === "redact_user_message" ? (
            <RedactDetailView d={entry.details as RedactDetails} />
          ) : (
            <ToolDetailView d={entry.details as ToolDetails} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Activity Page ──────────────────────────────────────────────────

export function ActivityPage() {
  const { data: activityData, isLoading } = useQuery<{ activity: ActivityEntry[] }>({
    queryKey: ["activity"],
    queryFn: () => api.get("/activity?limit=200"),
    refetchInterval: 30_000,
  });

  const { data: staffData } = useQuery<{ staff: StaffAgent[] }>({
    queryKey: ["staff"],
    queryFn: () => api.get("/staff"),
    retry: false,
  });

  const activity = activityData?.activity ?? [];
  const agentNameMap = new Map((staffData?.staff ?? []).map((s) => [s.id, s.name]));

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5" style={{ color: C.textMuted }} />
          <h2
            className="text-[22px] font-normal"
            style={{ color: C.navy, fontFamily: C.serif }}
          >
            Activity
          </h2>
        </div>
        <p className="text-[13px] mt-1" style={{ color: C.textSecondary }}>
          {isLoading ? "Loading…" : `${activity.length} event${activity.length !== 1 ? "s" : ""}`}
        </p>
      </div>

      <Card className="border" style={{ borderColor: C.border }}>
        <CardContent className="p-5">
          {/* Loading */}
          {isLoading && (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}

          {/* Empty */}
          {!isLoading && activity.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Activity className="h-8 w-8 mb-3" style={{ color: "#ddd5c8" }} />
              <p className="text-sm" style={{ color: C.textMuted }}>
                Activity will appear here when agents start working.
              </p>
            </div>
          )}

          {/* Timeline */}
          {!isLoading && activity.length > 0 && (
            <div>
              {activity.map((entry) => (
                <ActivityRow
                  key={entry.id}
                  entry={entry}
                  agentName={entry.agentId ? agentNameMap.get(entry.agentId) : undefined}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
