import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { PageShell } from "@/components/page-shell";
import { FolderGit2, Plus, Trash2, Check, EyeOff } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

interface Project {
  id: string;
  householdId: string;
  name: string;
  path: string;
  repoUrl: string | null;
  defaultBranch: string;
  testCmd: string | null;
  devCmd: string | null;
  enabled: boolean;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

interface HouseholdData {
  household: { id: string; name: string };
}

// ── Page ───────────────────────────────────────────────────────────

export function ProjectsPage() {
  const queryClient = useQueryClient();

  const { data: householdData } = useQuery<HouseholdData>({
    queryKey: ["household"],
    queryFn: () => api.get("/households/current"),
  });
  const householdId = householdData?.household.id;

  const { data, isLoading } = useQuery<{ projects: Project[] }>({
    queryKey: ["projects", householdId],
    queryFn: () => api.get(`/projects?householdId=${householdId}`),
    enabled: !!householdId,
  });
  const projects = data?.projects ?? [];

  const [showNew, setShowNew] = useState(false);
  const [form, setForm] = useState({
    name: "",
    path: "",
    defaultBranch: "main",
    testCmd: "",
    devCmd: "",
    repoUrl: "",
  });

  // Single ConfirmDialog handles both delete and disable confirmations —
  // each action wires through useConfirmDialog with its own metadata so the
  // title/description/tone reflect the requested action. Re-enable is direct
  // (no confirm) since it's safe.
  const [confirmConfig, setConfirmConfig] = useState<{
    title: string;
    description: React.ReactNode;
    confirmLabel: string;
    tone: "destructive" | "default";
  } | null>(null);
  const [confirmProps, askConfirm] = useConfirmDialog();

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!householdId) throw new Error("no household");
      return api.post("/projects", {
        householdId,
        name: form.name.trim(),
        path: form.path.trim(),
        defaultBranch: form.defaultBranch.trim() || "main",
        testCmd: form.testCmd.trim() || undefined,
        devCmd: form.devCmd.trim() || undefined,
        repoUrl: form.repoUrl.trim() || undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects", householdId] });
      setShowNew(false);
      setForm({ name: "", path: "", defaultBranch: "main", testCmd: "", devCmd: "", repoUrl: "" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (id: string) => api.post(`/projects/${id}/toggle`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects", householdId] }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`/projects/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["projects", householdId] }),
  });

  const createError = createMutation.error instanceof Error ? createMutation.error.message : null;

  const requestDisable = (project: Project) => {
    setConfirmConfig({
      title: `Disable project '${project.name}'?`,
      description:
        "Disabling stops new delegations to this project but keeps the registry entry. You can re-enable later.",
      confirmLabel: "Disable",
      tone: "default",
    });
    askConfirm(async () => {
      await toggleMutation.mutateAsync(project.id);
    });
  };

  const requestDelete = (project: Project) => {
    setConfirmConfig({
      title: `Delete project '${project.name}'?`,
      description:
        "Delegated tasks targeting this project will fail. This removes the registry entry permanently.",
      confirmLabel: "Delete",
      tone: "destructive",
    });
    askConfirm(async () => {
      await deleteMutation.mutateAsync(project.id);
    });
  };

  return (
    <PageShell maxWidth="5xl">
      <PageShell.Header>
        <div>
          <h1 className="text-2xl font-bold mb-1 font-serif">
            Projects
          </h1>
          <p className="text-sm text-carson-text-body">
            Registered projects that Developers can work in. Required for the <code>project</code>{" "}
            and <code>core</code> specialties.
          </p>
        </div>
        <Button
          onClick={() => setShowNew((s) => !s)}
          style={{ background: "#8b6f4e", color: "#fff" }}
        >
          <Plus className="h-4 w-4 mr-2" />
          Register project
        </Button>
      </PageShell.Header>

      {showNew && (
        <Card className="mb-6">
          <CardContent className="p-5 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Name" required name="project-name" autoComplete="off">
                <Input
                  placeholder="homeschool-happy"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </FormField>
              <FormField label="Default branch" name="project-branch" autoComplete="off">
                <Input
                  placeholder="main"
                  value={form.defaultBranch}
                  onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
                />
              </FormField>
            </div>
            <FormField
              label="Absolute path"
              required
              name="project-path"
              autoComplete="off"
              helper="Must exist on disk; the worktree provider needs read/write access here."
            >
              <Input
                placeholder="/Users/you/projects/homeschool-happy"
                value={form.path}
                onChange={(e) => setForm({ ...form, path: e.target.value })}
              />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Test command" name="project-test-cmd" autoComplete="off">
                <Input
                  placeholder="pnpm test"
                  value={form.testCmd}
                  onChange={(e) => setForm({ ...form, testCmd: e.target.value })}
                />
              </FormField>
              <FormField label="Dev command" name="project-dev-cmd" autoComplete="off">
                <Input
                  placeholder="pnpm dev"
                  value={form.devCmd}
                  onChange={(e) => setForm({ ...form, devCmd: e.target.value })}
                />
              </FormField>
            </div>
            <FormField label="Repo URL (optional)" name="project-repo-url" autoComplete="url">
              <Input
                placeholder="https://github.com/you/repo"
                value={form.repoUrl}
                onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
              />
            </FormField>
            {createError && (
              <div className="text-sm text-red-600">{createError}</div>
            )}
            <div className="flex gap-2 pt-1">
              <Button
                onClick={() => createMutation.mutate()}
                disabled={!form.name.trim() || !form.path.trim() || createMutation.isPending}
                style={{ background: "#8b6f4e", color: "#fff" }}
              >
                {createMutation.isPending ? "Saving…" : "Register"}
              </Button>
              <Button
                variant="outline"
                onClick={() => setShowNew(false)}
                disabled={createMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="text-sm text-carson-text-meta">Loading…</div>
      ) : projects.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-carson-text-meta">
            <FolderGit2 className="h-8 w-8 mx-auto mb-3 opacity-40" />
            <div className="text-sm">No projects registered yet.</div>
            <div className="text-xs mt-1">
              Click <b>Register project</b> above to add one. Your Chief of Staff can also register
              projects via the <code>register_project</code> tool.
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {projects.map((p) => (
            <Card key={p.id}>
              <CardContent className="p-4 flex items-center gap-4">
                <FolderGit2
                  className={`h-5 w-5 ${p.enabled ? "" : "opacity-40"}`}
                  style={{ color: p.enabled ? "#8b6f4e" : undefined }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{p.name}</div>
                    {!p.enabled && (
                      <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-[#eee] text-[#666]">
                        disabled
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-carson-text-body font-mono truncate">{p.path}</div>
                  <div className="text-xs text-carson-text-meta mt-0.5">
                    branch <b>{p.defaultBranch}</b>
                    {p.testCmd && (
                      <>
                        {" · "}test <code>{p.testCmd}</code>
                      </>
                    )}
                    {p.devCmd && (
                      <>
                        {" · "}dev <code>{p.devCmd}</code>
                      </>
                    )}
                  </div>
                </div>
                {p.enabled ? (
                  // Disabling has user-visible consequences (delegations stop)
                  // but it's reversible — ConfirmDialog with tone="default"
                  // matches that intent: stop and ask, but not red-button alarm.
                  <IconButton
                    aria-label="Disable project"
                    variant="outline"
                    size="md"
                    onClick={() => requestDisable(p)}
                    disabled={toggleMutation.isPending}
                  >
                    <EyeOff />
                  </IconButton>
                ) : (
                  <IconButton
                    aria-label="Enable project"
                    variant="outline"
                    size="md"
                    onClick={() => toggleMutation.mutate(p.id)}
                    disabled={toggleMutation.isPending}
                  >
                    <Check />
                  </IconButton>
                )}
                <IconButton
                  aria-label="Delete project"
                  variant="destructive"
                  size="md"
                  onClick={() => requestDelete(p)}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 />
                </IconButton>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {confirmConfig && (
        <ConfirmDialog
          {...confirmProps}
          title={confirmConfig.title}
          description={confirmConfig.description}
          confirmLabel={confirmConfig.confirmLabel}
          tone={confirmConfig.tone}
        />
      )}
    </PageShell>
  );
}
