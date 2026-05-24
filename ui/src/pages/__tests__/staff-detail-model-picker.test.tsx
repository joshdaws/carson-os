import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { StaffDetailPage } from "@/pages/StaffDetail";
import { IconButtonTooltipProvider } from "@/components/ui/icon-button";
import { ToastProvider } from "@/components/Toast";

/**
 * Pins the v0.6.0 model picker UI: the reasoning-effort selector is Codex-only
 * (it would be meaningless on Claude), and Codex is a selectable runtime.
 */
function renderStaff(agentOverrides: Record<string, unknown>) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  qc.setQueryData(["staff", "carson-1"], {
    agent: {
      id: "carson-1",
      name: "Carson",
      staffRole: "personal",
      status: "active",
      autonomyLevel: "supervised",
      trustLevel: "restricted",
      ...agentOverrides,
    },
    assignments: [],
  });
  qc.setQueryData(["household"], { household: { id: "h1", name: "Fam" }, members: [] });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/staff/carson-1"]}>
        <ToastProvider>
          <IconButtonTooltipProvider>
            <Routes>
              <Route path="/staff/:staffId" element={<StaffDetailPage />} />
            </Routes>
          </IconButtonTooltipProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("StaffDetail model picker", () => {
  it("always shows the model picker", () => {
    renderStaff({ model: "claude-sonnet-4-6" });
    expect(screen.getByText("Model:")).toBeInTheDocument();
  });

  it("shows the reasoning-effort picker for a Codex agent", () => {
    renderStaff({ model: "codex/gpt-5.5", reasoningEffort: "high" });
    expect(screen.getByText("Effort:")).toBeInTheDocument();
  });

  it("hides the reasoning-effort picker for a Claude agent", () => {
    renderStaff({ model: "claude-sonnet-4-6" });
    expect(screen.queryByText("Effort:")).not.toBeInTheDocument();
  });
});
