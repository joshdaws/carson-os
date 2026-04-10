/**
 * ToolsManager — per-agent tool toggles and trust level display.
 *
 * Fetches tools from GET /api/tools/agents/:agentId/grants
 * and provides toggles for builtin tools. System tools show as always-on.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";

interface ToolEntry {
  name: string;
  description: string;
  category: string;
  tier: "system" | "builtin" | "custom" | "discovered";
  granted: boolean;
}

interface ToolsGrantData {
  trustLevel: string;
  tools: ToolEntry[];
}

export function ToolsManager({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<ToolsGrantData>({
    queryKey: ["tools", "grants", agentId],
    queryFn: () => api.get(`/tools/agents/${agentId}/grants`),
    enabled: !!agentId,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ toolName, granted }: { toolName: string; granted: boolean }) =>
      api.put(`/tools/agents/${agentId}/grants`, { toolName, granted }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tools", "grants", agentId] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin" style={{ color: "#8a8070" }} />
        <span className="text-sm" style={{ color: "#8a8070" }}>Loading tools...</span>
      </div>
    );
  }

  if (!data || data.tools.length === 0) {
    return (
      <p className="text-sm py-2" style={{ color: "#8a8070" }}>
        No tools registered.
      </p>
    );
  }

  const systemTools = data.tools.filter((t) => t.tier === "system");
  const builtinTools = data.tools.filter((t) => t.tier === "builtin");
  const discoveredTools = data.tools.filter((t) => t.tier === "discovered");

  // Group builtins by category
  const builtinByCategory = new Map<string, ToolEntry[]>();
  for (const tool of builtinTools) {
    const group = builtinByCategory.get(tool.category) ?? [];
    group.push(tool);
    builtinByCategory.set(tool.category, group);
  }

  return (
    <div className="space-y-4">
      {/* System tools */}
      {systemTools.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "#8a8070" }}>
            System (always on)
          </p>
          <div className="flex flex-wrap gap-2">
            {systemTools.map((t) => (
              <Badge
                key={t.name}
                variant="secondary"
                className="text-[10px]"
                style={{ background: "#e8f5e9", color: "#2e7d32" }}
              >
                {t.name}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Builtin tools by category */}
      {[...builtinByCategory.entries()].map(([category, tools]) => (
        <div key={category}>
          <p className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "#8a8070" }}>
            {category}
          </p>
          <div className="space-y-1">
            {tools.map((t) => (
              <label
                key={t.name}
                className="flex items-center gap-3 py-1.5 px-3 rounded cursor-pointer hover:bg-[#faf8f4] transition-colors"
              >
                <input
                  type="checkbox"
                  checked={t.granted}
                  onChange={() =>
                    toggleMutation.mutate({ toolName: t.name, granted: !t.granted })
                  }
                  disabled={toggleMutation.isPending}
                  className="rounded"
                  style={{ accentColor: "#8b6f4e" }}
                />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium" style={{ color: "#1a1f2e" }}>
                    {t.name}
                  </span>
                  <p className="text-[10px] truncate" style={{ color: "#a09080" }}>
                    {t.description}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>
      ))}

      {/* Discovered skills */}
      {discoveredTools.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "#8a8070" }}>
            Discovered Skills
          </p>
          <div className="space-y-1">
            {discoveredTools.map((t) => (
              <label
                key={t.name}
                className="flex items-center gap-3 py-1.5 px-3 rounded cursor-pointer hover:bg-[#faf8f4] transition-colors"
              >
                <input
                  type="checkbox"
                  checked={t.granted}
                  onChange={() =>
                    toggleMutation.mutate({ toolName: t.name, granted: !t.granted })
                  }
                  disabled={toggleMutation.isPending}
                  className="rounded"
                  style={{ accentColor: "#8b6f4e" }}
                />
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium" style={{ color: "#1a1f2e" }}>
                    {t.name.replace("skill:", "")}
                  </span>
                  <p className="text-[10px] truncate" style={{ color: "#a09080" }}>
                    {t.description}
                  </p>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {discoveredTools.length === 0 && builtinTools.length === 0 && (
        <p className="text-xs" style={{ color: "#a09080" }}>
          Only system tools configured. Install additional tools to see them here.
        </p>
      )}
    </div>
  );
}
