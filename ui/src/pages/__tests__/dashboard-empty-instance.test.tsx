import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { DashboardPage } from "@/pages/Dashboard";
import { IconButtonTooltipProvider } from "@/components/ui/icon-button";

// Pin the empty-instance hero gate. The /ship pre-merge review flagged
// this twice: first because the gate fired during the loading-flash
// window, then because the gate fix BROKE the original 404-on-fresh-install
// case. Both regressions are user-visible (configured users see "Set up
// your household" mid-load; fresh installs never see the hero at all),
// and either is easy to silently re-introduce.
//
// The current contract:
//   - hero NEVER renders while either query is still pending
//   - hero renders when household errors (404 fresh install) AND staff is empty
//   - hero renders when household resolves with empty members AND staff is empty
//   - hero does NOT render when staff has any agents (even internal-only)

function renderDashboard(setupCache: (qc: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
      },
    },
  });
  setupCache(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IconButtonTooltipProvider>
          <DashboardPage />
        </IconButtonTooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const HERO_TEXT_RE = /Tell Carson who lives here/;

describe("DashboardPage empty-instance gate", () => {
  it("does NOT render the hero while household + staff queries are still pending", () => {
    // No setQueryData — both queries stay in pending state. dataLoaded
    // stays false, hero suppressed. This is the loading-flash regression
    // the v0.5.5 review caught.
    renderDashboard(() => {});
    expect(screen.queryByText(HERO_TEXT_RE)).not.toBeInTheDocument();
  });

  it("does NOT render the hero when household has members + agents", () => {
    renderDashboard((qc) => {
      qc.setQueryData(["household"], {
        household: { id: "h1", name: "The Daws Family" },
        members: [
          {
            id: "m1",
            name: "Josh",
            role: "parent",
            age: 48,
            telegramUserId: null,
            createdAt: new Date().toISOString(),
          },
        ],
      });
      qc.setQueryData(["staff"], {
        staff: [
          {
            id: "s1",
            name: "Carson",
            staffRole: "head_butler",
            specialty: null,
            roleContent: "",
            soulContent: null,
            visibility: "family",
            telegramBotToken: null,
            model: "claude-sonnet-4-6",
            status: "active",
            isHeadButler: true,
            autonomyLevel: "standard",
          },
        ],
      });
    });
    expect(screen.queryByText(HERO_TEXT_RE)).not.toBeInTheDocument();
  });

  it("does NOT render the hero when only internal staff exists (no members, no family agents)", () => {
    // The first /ship review caught that gating on familyAgents.length
    // misfired here — hero would show "tell Carson who lives here"
    // while the sidebar listed internal staff. Gate now uses staff.length.
    renderDashboard((qc) => {
      qc.setQueryData(["household"], {
        household: { id: "h1", name: "The Daws Family" },
        members: [],
      });
      qc.setQueryData(["staff"], {
        staff: [
          {
            id: "s1",
            name: "Dev",
            staffRole: "personal",
            specialty: "developer",
            roleContent: "",
            soulContent: null,
            visibility: "internal",
            telegramBotToken: null,
            model: "claude-sonnet-4-6",
            status: "active",
            isHeadButler: false,
            autonomyLevel: "standard",
          },
        ],
      });
    });
    expect(screen.queryByText(HERO_TEXT_RE)).not.toBeInTheDocument();
  });

  it("renders the hero when household resolves with members and staff both empty", () => {
    renderDashboard((qc) => {
      qc.setQueryData(["household"], {
        household: { id: "h1", name: "Sandbox" },
        members: [],
      });
      qc.setQueryData(["staff"], { staff: [] });
    });
    expect(screen.getByText(HERO_TEXT_RE)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Set up your household/ }),
    ).toBeInTheDocument();
  });

  it("renders the hero when /households/current 404s on a fresh install (codex P1 from v0.5.5 review)", async () => {
    // The codex-structured review of v0.5.5 caught that the loading-flash
    // fix (gating on data !== undefined) broke this exact case. 404s
    // leave data undefined but queryStatus === 'error', so the gate
    // must accept "settled" (success OR error), not just "data present."
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });

    // Force the household query into the error state by running the
    // queryFn with a rejection. fetchQuery returns a promise that will
    // resolve once the query settles into the error state in the cache.
    await queryClient
      .fetchQuery({
        queryKey: ["household"],
        queryFn: () => Promise.reject(new Error("Not Found")),
        retry: false,
      })
      .catch(() => {});
    queryClient.setQueryData(["staff"], { staff: [] });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <IconButtonTooltipProvider>
            <DashboardPage />
          </IconButtonTooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await vi.waitFor(() => {
      expect(screen.getByText(HERO_TEXT_RE)).toBeInTheDocument();
    });
  });
});
