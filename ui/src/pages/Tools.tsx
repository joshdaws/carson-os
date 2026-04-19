/**
 * Custom Tools Admin — list, inspect, approve, toggle, delete custom tools
 * + view + delete tool secrets.
 *
 * Single-household app: all data scoped to /households/current.
 *
 * Routes consumed:
 *   GET    /api/tools/custom?household_id=
 *   GET    /api/tools/custom/:id        — full detail (SKILL.md + handler.ts)
 *   POST   /api/tools/custom/:id/approve
 *   PUT    /api/tools/custom/:id/status
 *   DELETE /api/tools/custom/:id
 *   GET    /api/tools/secrets?household_id=
 *   DELETE /api/tools/secrets/:id
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Wrench,
  Code2,
  Globe,
  FileText,
  Power,
  Trash2,
  CheckCircle2,
  X,
  AlertTriangle,
  Key,
  RefreshCw,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

type ToolKind = "http" | "prompt" | "script";
type ToolStatus =
  | "active"
  | "disabled"
  | "pending_approval"
  | "promoted"
  | "broken";

interface CustomTool {
  id: string;
  householdId: string;
  name: string;
  kind: ToolKind;
  path: string;
  createdByAgentId: string;
  source: string;
  sourceUrl: string | null;
  status: ToolStatus;
  approvedContentHash: string | null;
  schemaVersion: number;
  generation: number;
  usageCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ToolDetail {
  tool: CustomTool;
  skillMd: string | null;
  handlerTs: string | null;
}

interface SecretEntry {
  id: string;
  keyName: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentSummary {
  id: string;
  name: string;
}

type StatusFilter = "all" | "pending_approval" | "active" | "disabled" | "broken";

// ── Style helpers ──────────────────────────────────────────────────

const STATUS_COLORS: Record<ToolStatus, { bg: string; fg: string; label: string }> = {
  active: { bg: "#e8f5e9", fg: "#2e7d32", label: "active" },
  pending_approval: { bg: "#fff4e0", fg: "#a06010", label: "pending approval" },
  disabled: { bg: "#eeeae3", fg: "#7a7060", label: "disabled" },
  broken: { bg: "#fde8e8", fg: "#a82020", label: "broken" },
  promoted: { bg: "#e0ecff", fg: "#1f4a8c", label: "promoted" },
};

const KIND_ICONS: Record<ToolKind, typeof Globe> = {
  http: Globe,
  prompt: FileText,
  script: Code2,
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diff = now - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) {
    const hr = Math.floor(diff / (60 * 60 * 1000));
    return hr === 0 ? "just now" : `${hr}h ago`;
  }
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return d.toLocaleDateString();
}

// ── Sub-components ─────────────────────────────────────────────────

function StatusBadge({ status }: { status: ToolStatus }) {
  const c = STATUS_COLORS[status];
  return (
    <Badge variant="secondary" className="text-[10px]" style={{ background: c.bg, color: c.fg }}>
      {c.label}
    </Badge>
  );
}

function KindIcon({ kind }: { kind: ToolKind }) {
  const Icon = KIND_ICONS[kind];
  return <Icon className="h-3.5 w-3.5" style={{ color: "#7a7060" }} />;
}

function SectionHeader({
  title,
  icon: Icon,
  count,
  action,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div
      className="px-4 py-3 border-b flex items-center justify-between"
      style={{ borderColor: "#eee8dd" }}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-[#8a8070]" />
        <h3 className="text-sm font-semibold" style={{ color: "#1a1f2e" }}>
          {title}
        </h3>
        {typeof count === "number" && (
          <span className="text-xs" style={{ color: "#7a7060" }}>
            ({count})
          </span>
        )}
      </div>
      {action}
    </div>
  );
}

function ConfirmDeleteOverlay({
  toolName,
  onConfirm,
  onCancel,
  pending,
}: {
  toolName: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(26, 31, 46, 0.4)" }}
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-md border p-5 max-w-md mx-4"
        style={{ borderColor: "#ddd5c8" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-3">
          <AlertTriangle className="h-5 w-5 mt-0.5" style={{ color: "#a82020" }} />
          <div>
            <h4 className="text-sm font-semibold" style={{ color: "#1a1f2e" }}>
              Delete {toolName}?
            </h4>
            <p className="text-xs mt-1" style={{ color: "#7a7060" }}>
              The tool will be marked as disabled and unregistered from active agents.
              The SKILL.md and handler files stay on disk so the action is recoverable
              if you change your mind.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={pending}
            style={{ background: "#a82020", color: "#fff" }}
          >
            {pending ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ToolDetailPanel({
  toolId,
  agents,
  onClose,
}: {
  toolId: string;
  agents: Map<string, string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data, isLoading, error } = useQuery<ToolDetail>({
    queryKey: ["tools", "custom", toolId],
    queryFn: () => api.get(`/tools/custom/${toolId}`),
  });

  const invalidateTools = () => {
    queryClient.invalidateQueries({ queryKey: ["tools", "custom"] });
  };

  const approveMutation = useMutation({
    mutationFn: () => api.post(`/tools/custom/${toolId}/approve`),
    onSuccess: invalidateTools,
  });

  const toggleMutation = useMutation({
    mutationFn: (status: "active" | "disabled") =>
      api.put(`/tools/custom/${toolId}/status`, { status }),
    onSuccess: invalidateTools,
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/tools/custom/${toolId}`),
    onSuccess: () => {
      invalidateTools();
      setConfirmDelete(false);
      onClose();
    },
  });

  const tool = data?.tool;

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: "rgba(26, 31, 46, 0.3)" }}
        onClick={onClose}
      />
      <div
        className="fixed top-0 right-0 z-40 h-full w-full max-w-2xl bg-white border-l overflow-y-auto"
        style={{ borderColor: "#ddd5c8" }}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 bg-white px-5 py-4 border-b flex items-start justify-between"
          style={{ borderColor: "#eee8dd" }}
        >
          <div className="flex-1 min-w-0">
            {tool ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <KindIcon kind={tool.kind} />
                  <h2
                    className="text-[18px] font-normal"
                    style={{
                      color: "#1a1f2e",
                      fontFamily: "Georgia, 'Times New Roman', serif",
                    }}
                  >
                    {tool.name}
                  </h2>
                  <StatusBadge status={tool.status} />
                </div>
                <p className="text-xs" style={{ color: "#7a7060" }}>
                  {tool.kind} tool · created by {agents.get(tool.createdByAgentId) ?? "unknown agent"} ·{" "}
                  {tool.source === "installed-skill" && tool.sourceUrl
                    ? `installed from ${tool.sourceUrl}`
                    : tool.source}
                </p>
              </>
            ) : (
              <h2 className="text-[18px]">Loading...</h2>
            )}
          </div>
          <button
            onClick={onClose}
            className="ml-3 p-1 rounded hover:bg-[#faf8f4]"
            aria-label="Close"
          >
            <X className="h-4 w-4" style={{ color: "#7a7060" }} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-5">
          {isLoading && (
            <p className="text-sm" style={{ color: "#7a7060" }}>
              Loading tool details...
            </p>
          )}

          {error && (
            <Card className="border" style={{ borderColor: "#fde8e8", background: "#fff8f8" }}>
              <CardContent className="p-3">
                <p className="text-xs" style={{ color: "#a82020" }}>
                  Failed to load tool details: {(error as Error).message}
                </p>
              </CardContent>
            </Card>
          )}

          {tool && (
            <>
              {/* Stats */}
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[1.5px] mb-1" style={{ color: "#8a8070" }}>
                    Usage
                  </p>
                  <p className="text-sm font-medium" style={{ color: "#1a1f2e" }}>
                    {tool.usageCount} call{tool.usageCount === 1 ? "" : "s"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[1.5px] mb-1" style={{ color: "#8a8070" }}>
                    Last used
                  </p>
                  <p className="text-sm font-medium" style={{ color: "#1a1f2e" }}>
                    {formatDate(tool.lastUsedAt)}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-[1.5px] mb-1" style={{ color: "#8a8070" }}>
                    Updated
                  </p>
                  <p className="text-sm font-medium" style={{ color: "#1a1f2e" }}>
                    {formatDate(tool.updatedAt)}
                  </p>
                </div>
              </div>

              {/* Last error (broken tools) */}
              {tool.status === "broken" && tool.lastError && (
                <Card className="border" style={{ borderColor: "#fde8e8", background: "#fff8f8" }}>
                  <CardContent className="p-3">
                    <p
                      className="text-[10px] uppercase tracking-[1.5px] mb-1"
                      style={{ color: "#a82020" }}
                    >
                      Last error
                    </p>
                    <pre
                      className="text-xs whitespace-pre-wrap font-mono"
                      style={{ color: "#1a1f2e" }}
                    >
                      {tool.lastError}
                    </pre>
                  </CardContent>
                </Card>
              )}

              {/* Path */}
              <div>
                <p className="text-[10px] uppercase tracking-[1.5px] mb-1" style={{ color: "#8a8070" }}>
                  File path
                </p>
                <code
                  className="text-xs"
                  style={{ color: "#3a4060", background: "#f4efe6", padding: "2px 6px", borderRadius: 3 }}
                >
                  ~/.carsonos/tools/{tool.householdId}/{tool.path}/
                </code>
              </div>

              {/* SKILL.md */}
              <div>
                <p className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "#8a8070" }}>
                  SKILL.md
                </p>
                {data?.skillMd ? (
                  <pre
                    className="text-xs font-mono p-3 rounded border overflow-x-auto"
                    style={{ background: "#faf8f4", borderColor: "#eee8dd", color: "#1a1f2e" }}
                  >
                    {data.skillMd}
                  </pre>
                ) : (
                  <p className="text-xs italic" style={{ color: "#a09080" }}>
                    No SKILL.md file found.
                  </p>
                )}
              </div>

              {/* handler.ts (script tools only) */}
              {tool.kind === "script" && (
                <div>
                  <p className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "#8a8070" }}>
                    handler.ts
                  </p>
                  {data?.handlerTs ? (
                    <pre
                      className="text-xs font-mono p-3 rounded border overflow-x-auto"
                      style={{ background: "#faf8f4", borderColor: "#eee8dd", color: "#1a1f2e" }}
                    >
                      {data.handlerTs}
                    </pre>
                  ) : (
                    <p className="text-xs italic" style={{ color: "#a09080" }}>
                      No handler.ts file found.
                    </p>
                  )}
                </div>
              )}

              {/* Actions */}
              <div
                className="flex flex-wrap gap-2 pt-2 border-t"
                style={{ borderColor: "#eee8dd" }}
              >
                {tool.status === "pending_approval" && (
                  <Button
                    size="sm"
                    onClick={() => approveMutation.mutate()}
                    disabled={approveMutation.isPending}
                    style={{ background: "#2e7d32", color: "#fff" }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                    {approveMutation.isPending ? "Approving..." : "Approve"}
                  </Button>
                )}

                {tool.status !== "pending_approval" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      toggleMutation.mutate(tool.status === "active" ? "disabled" : "active")
                    }
                    disabled={toggleMutation.isPending}
                    style={{ borderColor: "#ddd5c8" }}
                  >
                    <Power className="h-3.5 w-3.5 mr-1.5" />
                    {toggleMutation.isPending
                      ? "Updating..."
                      : tool.status === "active"
                        ? "Disable"
                        : "Enable"}
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleteMutation.isPending}
                  style={{ borderColor: "#ddd5c8", color: "#a82020" }}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Delete
                </Button>

                {(approveMutation.error || toggleMutation.error || deleteMutation.error) && (
                  <p className="text-xs w-full mt-1" style={{ color: "#a82020" }}>
                    {((approveMutation.error || toggleMutation.error || deleteMutation.error) as Error)
                      .message}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {confirmDelete && tool && (
        <ConfirmDeleteOverlay
          toolName={tool.name}
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => setConfirmDelete(false)}
          pending={deleteMutation.isPending}
        />
      )}
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────────

export default function ToolsPage() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [confirmSecretDelete, setConfirmSecretDelete] = useState<SecretEntry | null>(null);

  const { data: householdData } = useQuery<{ household: { id: string; name: string } }>({
    queryKey: ["household"],
    queryFn: () => api.get("/households/current"),
  });
  const householdId = householdData?.household.id;

  const { data: agentsData } = useQuery<{ staff: AgentSummary[] }>({
    queryKey: ["staff"],
    queryFn: () => api.get("/staff"),
  });

  const agentMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agentsData?.staff ?? []) m.set(a.id, a.name);
    return m;
  }, [agentsData]);

  const { data: toolsData, isLoading: toolsLoading } = useQuery<{ customTools: CustomTool[] }>({
    queryKey: ["tools", "custom", "list", householdId],
    queryFn: () => api.get(`/tools/custom?household_id=${householdId}`),
    enabled: !!householdId,
  });

  const { data: secretsData } = useQuery<{ secrets: SecretEntry[] }>({
    queryKey: ["tools", "secrets", householdId],
    queryFn: () => api.get(`/tools/secrets?household_id=${householdId}`),
    enabled: !!householdId,
  });

  const deleteSecretMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/tools/secrets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tools", "secrets"] });
      setConfirmSecretDelete(null);
    },
  });

  const allTools = toolsData?.customTools ?? [];

  // Counts for filter tabs
  const counts = useMemo(() => {
    const c = { all: allTools.length, pending_approval: 0, active: 0, disabled: 0, broken: 0 };
    for (const t of allTools) {
      if (t.status in c) c[t.status as keyof typeof c]++;
    }
    return c;
  }, [allTools]);

  const filteredTools = useMemo(() => {
    if (filter === "all") return allTools;
    return allTools.filter((t) => t.status === filter);
  }, [allTools, filter]);

  const filterTabs: Array<{ key: StatusFilter; label: string; emphasize?: boolean }> = [
    { key: "all", label: "All" },
    { key: "pending_approval", label: "Pending", emphasize: counts.pending_approval > 0 },
    { key: "active", label: "Active" },
    { key: "disabled", label: "Disabled" },
    { key: "broken", label: "Broken", emphasize: counts.broken > 0 },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-5xl">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Wrench className="h-5 w-5" style={{ color: "#8a8070" }} />
          <h2
            className="text-[22px] font-normal"
            style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            Custom Tools
          </h2>
        </div>
        <p className="text-[13px] mt-1" style={{ color: "#7a7060" }}>
          Tools your agents have created or installed. Files live at{" "}
          <code style={{ color: "#3a4060" }}>~/.carsonos/tools/</code>.
        </p>
      </div>

      {/* Filter tabs */}
      <div
        className="flex gap-1 mb-4 border-b"
        style={{ borderColor: "#ddd5c8" }}
      >
        {filterTabs.map((tab) => {
          const isActive = filter === tab.key;
          const count = counts[tab.key];
          return (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className="px-3 py-2 text-xs transition-colors relative"
              style={{
                color: isActive ? "#1a1f2e" : "#7a7060",
                fontWeight: isActive ? 600 : 400,
                borderBottom: isActive ? "2px solid #8b6f4e" : "2px solid transparent",
                marginBottom: -1,
              }}
            >
              {tab.label}
              {count > 0 && (
                <span
                  className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: tab.emphasize ? "#fff4e0" : "#f4efe6",
                    color: tab.emphasize ? "#a06010" : "#7a7060",
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tools table */}
      <Card className="border mb-6" style={{ borderColor: "#ddd5c8" }}>
        <CardContent className="p-0">
          {toolsLoading ? (
            <p className="text-sm p-4" style={{ color: "#7a7060" }}>
              Loading custom tools...
            </p>
          ) : filteredTools.length === 0 ? (
            <div className="p-8 text-center">
              <Wrench className="h-8 w-8 mx-auto mb-2" style={{ color: "#ddd5c8" }} />
              <p className="text-sm" style={{ color: "#7a7060" }}>
                {filter === "all"
                  ? "No custom tools yet. Agents create tools through conversation using create_http_tool, create_prompt_tool, or create_script_tool."
                  : `No tools with status "${filter.replace("_", " ")}".`}
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid #eee8dd" }}>
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium" style={{ color: "#8a8070" }}>
                    Name
                  </th>
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium" style={{ color: "#8a8070" }}>
                    Kind
                  </th>
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium" style={{ color: "#8a8070" }}>
                    Status
                  </th>
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium" style={{ color: "#8a8070" }}>
                    Created by
                  </th>
                  <th className="text-right px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium" style={{ color: "#8a8070" }}>
                    Usage
                  </th>
                  <th className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium" style={{ color: "#8a8070" }}>
                    Last used
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredTools.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setSelectedToolId(t.id)}
                    className="cursor-pointer hover:bg-[#faf8f4] transition-colors"
                    style={{ borderBottom: "1px solid #f4efe6" }}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <KindIcon kind={t.kind} />
                        <span style={{ color: "#1a1f2e" }}>{t.name}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: "#7a7060" }}>
                      {t.kind}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: "#7a7060" }}>
                      {agentMap.get(t.createdByAgentId) ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-right" style={{ color: "#7a7060" }}>
                      {t.usageCount}
                    </td>
                    <td className="px-4 py-3 text-xs" style={{ color: "#7a7060" }}>
                      {formatDate(t.lastUsedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Secrets section */}
      <Card className="border" style={{ borderColor: "#ddd5c8" }}>
        <SectionHeader
          title="Tool Secrets"
          icon={Key}
          count={secretsData?.secrets.length}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                queryClient.invalidateQueries({ queryKey: ["tools", "secrets"] })
              }
              className="h-7 px-2"
            >
              <RefreshCw className="h-3 w-3" style={{ color: "#7a7060" }} />
            </Button>
          }
        />
        <CardContent className="p-4">
          <p className="text-xs mb-3" style={{ color: "#7a7060" }}>
            Encrypted with AES-256-GCM. Values are never returned by the API. Agents
            create secrets through conversation using <code>store_secret</code>.
          </p>
          {!secretsData || secretsData.secrets.length === 0 ? (
            <p className="text-xs italic py-2" style={{ color: "#a09080" }}>
              No secrets stored.
            </p>
          ) : (
            <ul className="space-y-1">
              {secretsData.secrets.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between py-2 px-3 rounded hover:bg-[#faf8f4]"
                >
                  <div>
                    <code className="text-xs font-mono" style={{ color: "#1a1f2e" }}>
                      {s.keyName}
                    </code>
                    <span className="text-[10px] ml-3" style={{ color: "#a09080" }}>
                      added {formatDate(s.createdAt)}
                    </span>
                  </div>
                  <button
                    onClick={() => setConfirmSecretDelete(s)}
                    className="p-1 rounded hover:bg-[#fde8e8]"
                    aria-label={`Delete secret ${s.keyName}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" style={{ color: "#a82020" }} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Detail panel */}
      {selectedToolId && (
        <ToolDetailPanel
          toolId={selectedToolId}
          agents={agentMap}
          onClose={() => setSelectedToolId(null)}
        />
      )}

      {/* Confirm secret delete */}
      {confirmSecretDelete && (
        <ConfirmDeleteOverlay
          toolName={`secret "${confirmSecretDelete.keyName}"`}
          onConfirm={() => deleteSecretMutation.mutate(confirmSecretDelete.id)}
          onCancel={() => setConfirmSecretDelete(null)}
          pending={deleteSecretMutation.isPending}
        />
      )}
    </div>
  );
}
