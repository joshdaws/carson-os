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
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
  Package,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Download,
  FileQuestion,
  ArrowRight,
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

// ── Bundle helpers ─────────────────────────────────────────────────

/**
 * Tools live at ~/.carsonos/tools/{household}/{path}/. The path is either
 *   - "tool_name"               (standalone)
 *   - "bundle_name/tool_name"   (bundle of related tools)
 * Returns the bundle name if the tool lives in one, otherwise null.
 */
function bundleNameFor(tool: CustomTool): string | null {
  const segments = tool.path.split("/").filter(Boolean);
  return segments.length > 1 ? segments[0] : null;
}

interface BundleGroup {
  type: "bundle";
  name: string;
  tools: CustomTool[];
  activeCount: number;
  pendingCount: number;
  brokenCount: number;
  totalUsage: number;
}

interface SoloEntry {
  type: "solo";
  tool: CustomTool;
}

type ToolsListEntry = BundleGroup | SoloEntry;

/**
 * Group tools by bundle. Bundles with only one member collapse to a solo entry
 * so we don't add nesting overhead for nothing. Sort: bundles first (alpha),
 * then solo tools (alpha).
 */
function groupByBundle(tools: CustomTool[]): ToolsListEntry[] {
  const bundles = new Map<string, CustomTool[]>();
  const solos: CustomTool[] = [];

  for (const t of tools) {
    const b = bundleNameFor(t);
    if (b) {
      const list = bundles.get(b) ?? [];
      list.push(t);
      bundles.set(b, list);
    } else {
      solos.push(t);
    }
  }

  const groups: ToolsListEntry[] = [];
  for (const [name, members] of [...bundles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (members.length === 1) {
      solos.push(members[0]);
      continue;
    }
    const stats = members.reduce(
      (acc, m) => {
        if (m.status === "active") acc.activeCount++;
        if (m.status === "pending_approval") acc.pendingCount++;
        if (m.status === "broken") acc.brokenCount++;
        acc.totalUsage += m.usageCount;
        return acc;
      },
      { activeCount: 0, pendingCount: 0, brokenCount: 0, totalUsage: 0 },
    );
    groups.push({
      type: "bundle",
      name,
      tools: members.sort((a, b) => a.name.localeCompare(b.name)),
      ...stats,
    });
  }
  for (const t of solos.sort((a, b) => a.name.localeCompare(b.name))) {
    groups.push({ type: "solo", tool: t });
  }
  return groups;
}

// ── SKILL.md frontmatter parsing ───────────────────────────────────

interface ParsedSkillMd {
  frontmatter: Record<string, string> | null;
  body: string;
}

/**
 * Split out the YAML frontmatter from the markdown body. Only the metadata
 * fields humans care about (name, description, kind, source-related) are
 * surfaced. Implementation details (input_schema, http config, script entry
 * point) live in the YAML but are noisy in a metadata table — they're skipped
 * here. Everything past the closing `---` is rendered as markdown.
 */
const METADATA_KEYS = new Set([
  "name",
  "description",
  "kind",
  "version",
  "author",
  "source",
  "url",
  "license",
  "homepage",
]);

function parseSkillMd(content: string): ParsedSkillMd {
  const trimmed = content.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return { frontmatter: null, body: trimmed };
  }
  const end = trimmed.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: null, body: trimmed };
  }
  const frontmatterRaw = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).trim();
  const fm: Record<string, string> = {};
  for (const line of frontmatterRaw.split("\n")) {
    if (/^\s/.test(line)) continue; // skip indented (nested) lines
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.+)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (!value || value === "{}" || value === "[]" || value === "|" || value === ">") continue;
    if (!METADATA_KEYS.has(m[1])) continue;
    fm[m[1]] = value;
  }
  return { frontmatter: fm, body };
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

function SkillMdView({ skillMd }: { skillMd: string | null }) {
  const parsed = useMemo(() => (skillMd ? parseSkillMd(skillMd) : null), [skillMd]);

  if (!skillMd || !parsed) {
    return (
      <div>
        <p className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "#8a8070" }}>
          SKILL.md
        </p>
        <p className="text-xs italic" style={{ color: "#a09080" }}>
          No SKILL.md file found.
        </p>
      </div>
    );
  }

  const fm = parsed.frontmatter;

  return (
    <div className="space-y-4">
      {fm && Object.keys(fm).length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "#8a8070" }}>
            Metadata
          </p>
          <div
            className="rounded border divide-y"
            style={{ borderColor: "#eee8dd", background: "#faf8f4" }}
          >
            {Object.entries(fm).map(([k, v]) => (
              <div
                key={k}
                className="grid grid-cols-[120px_1fr] gap-3 px-3 py-2 text-xs"
                style={{ borderColor: "#eee8dd" }}
              >
                <code style={{ color: "#7a7060" }}>{k}</code>
                <span className="break-words" style={{ color: "#1a1f2e" }}>
                  {v}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "#8a8070" }}>
          SKILL.md
        </p>
        <div
          className="prose prose-sm max-w-none rounded border p-4"
          style={{ borderColor: "#eee8dd", background: "#faf8f4", color: "#1a1f2e" }}
        >
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => (
                <h1 className="text-base font-semibold mb-2 mt-0" style={{ color: "#1a1f2e" }}>
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2
                  className="text-sm font-semibold mb-2 mt-4"
                  style={{ color: "#1a1f2e" }}
                >
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 className="text-xs font-semibold mb-1.5 mt-3" style={{ color: "#1a1f2e" }}>
                  {children}
                </h3>
              ),
              p: ({ children }) => (
                <p className="text-xs leading-relaxed mb-2" style={{ color: "#1a1f2e" }}>
                  {children}
                </p>
              ),
              ul: ({ children }) => (
                <ul className="text-xs leading-relaxed mb-2 ml-5 list-disc" style={{ color: "#1a1f2e" }}>
                  {children}
                </ul>
              ),
              ol: ({ children }) => (
                <ol
                  className="text-xs leading-relaxed mb-2 ml-5 list-decimal"
                  style={{ color: "#1a1f2e" }}
                >
                  {children}
                </ol>
              ),
              li: ({ children }) => <li className="mb-0.5">{children}</li>,
              code: ({ children, className }) => {
                // Block code (has className like "language-xxx")
                if (className) {
                  return (
                    <code
                      className={className}
                      style={{
                        display: "block",
                        background: "#f1ece2",
                        padding: "8px 10px",
                        borderRadius: 3,
                        fontSize: 11,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        color: "#1a1f2e",
                      }}
                    >
                      {children}
                    </code>
                  );
                }
                // Inline code
                return (
                  <code
                    style={{
                      background: "#f1ece2",
                      padding: "1px 5px",
                      borderRadius: 3,
                      fontSize: 11,
                      color: "#3a4060",
                    }}
                  >
                    {children}
                  </code>
                );
              },
              pre: ({ children }) => <>{children}</>,
              a: ({ href, children }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#3a4060", textDecoration: "underline" }}
                >
                  {children}
                </a>
              ),
              hr: () => (
                <hr className="my-3" style={{ borderColor: "#eee8dd", borderTopWidth: 1 }} />
              ),
              blockquote: ({ children }) => (
                <blockquote
                  className="text-xs italic pl-3 my-2"
                  style={{ borderLeft: "2px solid #ddd5c8", color: "#5a5a5a" }}
                >
                  {children}
                </blockquote>
              ),
            }}
          >
            {parsed.body}
          </Markdown>
        </div>
      </div>
    </div>
  );
}

function RawSkillMdToggle({ skillMd }: { skillMd: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="text-xs"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary
        className="cursor-pointer select-none py-1"
        style={{ color: "#7a7060" }}
      >
        {open ? "Hide" : "Show"} raw SKILL.md
      </summary>
      <pre
        className="text-xs font-mono p-3 mt-2 rounded border overflow-x-auto"
        style={{
          background: "#faf8f4",
          borderColor: "#eee8dd",
          color: "#1a1f2e",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {skillMd}
      </pre>
    </details>
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

              {/* Source — extra prominence for installed skills */}
              {tool.source === "installed-skill" && tool.sourceUrl && (
                <Card className="border" style={{ borderColor: "#dde6f0", background: "#f6f9fc" }}>
                  <CardContent className="p-3 flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p
                        className="text-[10px] uppercase tracking-[1.5px] mb-1"
                        style={{ color: "#3a4060" }}
                      >
                        Installed skill
                      </p>
                      <a
                        href={tool.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs hover:underline inline-flex items-center gap-1 break-all"
                        style={{ color: "#3a4060" }}
                      >
                        {tool.sourceUrl}
                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                      </a>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled
                      title="Upstream update check coming in a future release"
                      style={{ borderColor: "#ddd5c8" }}
                    >
                      <Download className="h-3.5 w-3.5 mr-1.5" />
                      Check for updates
                    </Button>
                  </CardContent>
                </Card>
              )}

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

              {/* SKILL.md — frontmatter as metadata, body as rendered markdown */}
              <SkillMdView skillMd={data?.skillMd ?? null} />

              {/* Raw view toggle for the curious / debugging */}
              {data?.skillMd && <RawSkillMdToggle skillMd={data.skillMd} />}

              {/* handler.ts (script tools only) — wrap long lines so it doesn't punch out of the panel */}
              {tool.kind === "script" && (
                <div>
                  <p className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "#8a8070" }}>
                    handler.ts
                  </p>
                  {data?.handlerTs ? (
                    <pre
                      className="text-xs font-mono p-3 rounded border"
                      style={{
                        background: "#faf8f4",
                        borderColor: "#eee8dd",
                        color: "#1a1f2e",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
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

// ── Tools table ────────────────────────────────────────────────────

function BundleStatusSummary({ b }: { b: BundleGroup }) {
  // Show pending and broken loud, "active" muted because it's the common case.
  return (
    <div className="flex items-center gap-1.5">
      {b.pendingCount > 0 && (
        <Badge
          variant="secondary"
          className="text-[10px]"
          style={{ background: "#fff4e0", color: "#a06010" }}
        >
          {b.pendingCount} pending
        </Badge>
      )}
      {b.brokenCount > 0 && (
        <Badge
          variant="secondary"
          className="text-[10px]"
          style={{ background: "#fde8e8", color: "#a82020" }}
        >
          {b.brokenCount} broken
        </Badge>
      )}
      {b.pendingCount === 0 && b.brokenCount === 0 && (
        <Badge
          variant="secondary"
          className="text-[10px]"
          style={{ background: "#e8f5e9", color: "#2e7d32" }}
        >
          all active
        </Badge>
      )}
    </div>
  );
}

function ToolRow({
  t,
  agentMap,
  onSelect,
  indent,
}: {
  t: CustomTool;
  agentMap: Map<string, string>;
  onSelect: (id: string) => void;
  indent?: boolean;
}) {
  return (
    <tr
      onClick={() => onSelect(t.id)}
      className="cursor-pointer hover:bg-[#faf8f4] transition-colors"
      style={{ borderBottom: "1px solid #f4efe6" }}
    >
      <td className="px-4 py-2.5">
        <div
          className="flex items-center gap-2"
          style={{ paddingLeft: indent ? 24 : 0 }}
        >
          <KindIcon kind={t.kind} />
          <span style={{ color: "#1a1f2e" }}>{t.name}</span>
        </div>
      </td>
      <td className="px-4 py-2.5 text-xs" style={{ color: "#7a7060" }}>
        {t.kind}
      </td>
      <td className="px-4 py-2.5">
        <StatusBadge status={t.status} />
      </td>
      <td className="px-4 py-2.5 text-xs" style={{ color: "#7a7060" }}>
        {agentMap.get(t.createdByAgentId) ?? "—"}
      </td>
      <td className="px-4 py-2.5 text-xs text-right" style={{ color: "#7a7060" }}>
        {t.usageCount}
      </td>
      <td className="px-4 py-2.5 text-xs" style={{ color: "#7a7060" }}>
        {formatDate(t.lastUsedAt)}
      </td>
    </tr>
  );
}

function ToolsTable({
  entries,
  agentMap,
  expandedBundles,
  onToggleBundle,
  onSelectTool,
}: {
  entries: ToolsListEntry[];
  agentMap: Map<string, string>;
  expandedBundles: Set<string>;
  onToggleBundle: (name: string) => void;
  onSelectTool: (id: string) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr style={{ borderBottom: "1px solid #eee8dd" }}>
          <th
            className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium"
            style={{ color: "#8a8070" }}
          >
            Name
          </th>
          <th
            className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium"
            style={{ color: "#8a8070" }}
          >
            Kind
          </th>
          <th
            className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium"
            style={{ color: "#8a8070" }}
          >
            Status
          </th>
          <th
            className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium"
            style={{ color: "#8a8070" }}
          >
            Created by
          </th>
          <th
            className="text-right px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium"
            style={{ color: "#8a8070" }}
          >
            Usage
          </th>
          <th
            className="text-left px-4 py-2 text-[10px] uppercase tracking-[1.5px] font-medium"
            style={{ color: "#8a8070" }}
          >
            Last used
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => {
          if (entry.type === "solo") {
            return (
              <ToolRow
                key={entry.tool.id}
                t={entry.tool}
                agentMap={agentMap}
                onSelect={onSelectTool}
              />
            );
          }
          const expanded = expandedBundles.has(entry.name);
          return (
            <ToolBundleRows
              key={`bundle:${entry.name}`}
              bundle={entry}
              expanded={expanded}
              onToggle={() => onToggleBundle(entry.name)}
              agentMap={agentMap}
              onSelectTool={onSelectTool}
            />
          );
        })}
      </tbody>
    </table>
  );
}

function ToolBundleRows({
  bundle,
  expanded,
  onToggle,
  agentMap,
  onSelectTool,
}: {
  bundle: BundleGroup;
  expanded: boolean;
  onToggle: () => void;
  agentMap: Map<string, string>;
  onSelectTool: (id: string) => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer hover:bg-[#faf8f4] transition-colors"
        style={{ borderBottom: "1px solid #f4efe6", background: "#faf8f4" }}
      >
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Chevron className="h-3.5 w-3.5" style={{ color: "#7a7060" }} />
            <Package className="h-3.5 w-3.5" style={{ color: "#7a7060" }} />
            <span className="font-medium" style={{ color: "#1a1f2e" }}>
              {bundle.name}
            </span>
            <span className="text-xs" style={{ color: "#7a7060" }}>
              ({bundle.tools.length} tools)
            </span>
          </div>
        </td>
        <td className="px-4 py-2.5 text-xs" style={{ color: "#7a7060" }}>
          bundle
        </td>
        <td className="px-4 py-2.5">
          <BundleStatusSummary b={bundle} />
        </td>
        <td className="px-4 py-2.5 text-xs" style={{ color: "#7a7060" }}>
          {(() => {
            const agents = new Set(
              bundle.tools.map((t) => agentMap.get(t.createdByAgentId) ?? "—"),
            );
            return agents.size === 1 ? [...agents][0] : `${agents.size} agents`;
          })()}
        </td>
        <td className="px-4 py-2.5 text-xs text-right" style={{ color: "#7a7060" }}>
          {bundle.totalUsage}
        </td>
        <td className="px-4 py-2.5 text-xs" style={{ color: "#7a7060" }}>
          {(() => {
            const last = bundle.tools
              .map((t) => (t.lastUsedAt ? new Date(t.lastUsedAt).getTime() : 0))
              .reduce((a, b) => Math.max(a, b), 0);
            return last === 0 ? "—" : formatDate(new Date(last).toISOString());
          })()}
        </td>
      </tr>
      {expanded &&
        bundle.tools.map((t) => (
          <ToolRow
            key={t.id}
            t={t}
            agentMap={agentMap}
            onSelect={onSelectTool}
            indent
          />
        ))}
    </>
  );
}

// ── Orphan importer ────────────────────────────────────────────────

interface OrphanEntry {
  bundle: string | null;
  toolName: string;
  relPath: string;
  parsed: { name: string; description: string; kind: string; hasHandler: boolean } | null;
  parseError: string | null;
  nameConflict: boolean;
}

function OrphanImporterModal({
  householdId,
  orphans,
  onClose,
  onImported,
}: {
  householdId: string;
  orphans: OrphanEntry[];
  onClose: () => void;
  onImported: () => void;
}) {
  // Default-select every orphan that's parseable and conflict-free
  const importable = useMemo(
    () => orphans.filter((o) => o.parsed && !o.parseError && !o.nameConflict),
    [orphans],
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(importable.map((o) => o.relPath)),
  );

  const importMutation = useMutation({
    mutationFn: (paths: string[]) =>
      api.post<{ imported: number; importedPaths: string[]; failed: Array<{ relPath: string; error: string }> }>(
        `/tools/custom/import-orphans`,
        { household_id: householdId, paths },
      ),
    onSuccess: (result) => {
      if (result.failed.length === 0) {
        onImported();
        onClose();
      }
      // If some failed, leave the modal open so the user can see what didn't import
    },
  });

  const toggle = (relPath: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const failedMap = new Map(
    (importMutation.data?.failed ?? []).map((f) => [f.relPath, f.error]),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(26, 31, 46, 0.4)" }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-md border max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col"
        style={{ borderColor: "#ddd5c8" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-5 py-4 border-b flex items-start justify-between"
          style={{ borderColor: "#eee8dd" }}
        >
          <div>
            <h3 className="text-base font-semibold" style={{ color: "#1a1f2e" }}>
              Import orphan tools
            </h3>
            <p className="text-xs mt-1" style={{ color: "#7a7060" }}>
              Found {orphans.length} SKILL.md file{orphans.length === 1 ? "" : "s"} on disk
              with no matching registry row. Pick which to import.
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-3 p-1 rounded hover:bg-[#faf8f4]"
            aria-label="Close"
          >
            <X className="h-4 w-4" style={{ color: "#7a7060" }} />
          </button>
        </div>

        {/* List */}
        <div className="overflow-y-auto flex-1 p-5 space-y-2">
          {orphans.map((o) => {
            const blocked = !o.parsed || !!o.parseError || o.nameConflict;
            const importFailed = failedMap.get(o.relPath);
            const isSelected = selected.has(o.relPath);

            return (
              <div
                key={o.relPath}
                className="rounded border p-3"
                style={{
                  borderColor: blocked ? "#fde8e8" : isSelected ? "#8b6f4e" : "#eee8dd",
                  background: blocked ? "#fff8f8" : "#faf8f4",
                  opacity: blocked ? 0.85 : 1,
                }}
              >
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={blocked || importMutation.isPending}
                    onChange={() => toggle(o.relPath)}
                    className="mt-1"
                    style={{ accentColor: "#8b6f4e" }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <code className="text-xs font-mono" style={{ color: "#1a1f2e" }}>
                        {o.relPath}
                      </code>
                      {o.parsed && (
                        <Badge
                          variant="secondary"
                          className="text-[10px]"
                          style={{ background: "#f4efe6", color: "#5a5a5a" }}
                        >
                          {o.parsed.kind}
                        </Badge>
                      )}
                    </div>
                    {o.parsed && (
                      <p className="text-xs mt-1" style={{ color: "#5a5a5a" }}>
                        <span className="font-medium" style={{ color: "#1a1f2e" }}>
                          {o.parsed.name}
                        </span>{" "}
                        — {o.parsed.description}
                      </p>
                    )}
                    {o.parseError && (
                      <p className="text-xs mt-1" style={{ color: "#a82020" }}>
                        Parse error: {o.parseError}
                      </p>
                    )}
                    {o.nameConflict && o.parsed && (
                      <p className="text-xs mt-1" style={{ color: "#a82020" }}>
                        Name conflict: a tool named "{o.parsed.name}" already exists. Rename
                        the SKILL.md or delete the existing tool first.
                      </p>
                    )}
                    {importFailed && (
                      <p className="text-xs mt-1" style={{ color: "#a82020" }}>
                        Import failed: {importFailed}
                      </p>
                    )}
                  </div>
                </label>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-3 border-t flex items-center justify-between"
          style={{ borderColor: "#eee8dd" }}
        >
          <p className="text-xs" style={{ color: "#7a7060" }}>
            {selected.size} of {importable.length} importable selected
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={importMutation.isPending}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => importMutation.mutate([...selected])}
              disabled={selected.size === 0 || importMutation.isPending}
              style={{ background: "#1a1f2e", color: "#e8dfd0" }}
            >
              {importMutation.isPending
                ? "Importing..."
                : `Import ${selected.size} tool${selected.size === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
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

  const { data: orphansData } = useQuery<{ orphans: OrphanEntry[] }>({
    queryKey: ["tools", "orphans", householdId],
    queryFn: () => api.get(`/tools/custom/orphans?household_id=${householdId}`),
    enabled: !!householdId,
  });
  const orphans = orphansData?.orphans ?? [];
  const [orphanModalOpen, setOrphanModalOpen] = useState(false);

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

  const groupedEntries = useMemo(() => groupByBundle(filteredTools), [filteredTools]);
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(new Set());

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

      {/* Orphan banner — only when SKILL.md files on disk are not registered */}
      {orphans.length > 0 && (
        <button
          onClick={() => setOrphanModalOpen(true)}
          className="w-full text-left mb-4 rounded border p-3 flex items-center gap-3 hover:bg-[#fef9eb] transition-colors"
          style={{ borderColor: "#f0d99b", background: "#fffaef" }}
        >
          <FileQuestion className="h-4 w-4 flex-shrink-0" style={{ color: "#a06010" }} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium" style={{ color: "#1a1f2e" }}>
              Found {orphans.length} SKILL.md file{orphans.length === 1 ? "" : "s"} on disk
              that {orphans.length === 1 ? "isn't" : "aren't"} registered.
            </p>
            <p className="text-[10px]" style={{ color: "#7a7060" }}>
              Hand-authored, synced from another machine, or restored from backup. Review and import.
            </p>
          </div>
          <ArrowRight className="h-4 w-4 flex-shrink-0" style={{ color: "#a06010" }} />
        </button>
      )}

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
            <ToolsTable
              entries={groupedEntries}
              agentMap={agentMap}
              expandedBundles={expandedBundles}
              onToggleBundle={(name) =>
                setExpandedBundles((prev) => {
                  const next = new Set(prev);
                  if (next.has(name)) next.delete(name);
                  else next.add(name);
                  return next;
                })
              }
              onSelectTool={setSelectedToolId}
            />
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

      {/* Orphan importer modal */}
      {orphanModalOpen && householdId && (
        <OrphanImporterModal
          householdId={householdId}
          orphans={orphans}
          onClose={() => setOrphanModalOpen(false)}
          onImported={() => {
            queryClient.invalidateQueries({ queryKey: ["tools", "custom"] });
            queryClient.invalidateQueries({ queryKey: ["tools", "orphans"] });
          }}
        />
      )}
    </div>
  );
}
