import { useState } from "react";
import { Outlet, NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useLiveUpdates } from "@/context/LiveUpdatesProvider";
import {
  LayoutDashboard,
  Users,
  ScrollText,
  ListTodo,
  MessageSquare,
  Settings,
  Clock,
  Wrench,
  Wifi,
  WifiOff,
  Menu,
  X,
  FolderGit2,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────

interface StaffAgent {
  id: string;
  name: string;
  staffRole: string;
  status: string;
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

// ── Nav helpers ────────────────────────────────────────────────────

function NavItem({
  to,
  icon: Icon,
  label,
  end,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 px-5 py-2.5 text-sm border-l-3 border-transparent transition-colors",
          isActive
            ? "font-medium"
            : "hover:bg-[#242a3a]",
        )
      }
      style={({ isActive }) => ({
        background: isActive ? "#242a3a" : undefined,
        borderLeftColor: isActive ? "#8b6f4e" : "transparent",
        color: isActive ? "#e8dfd0" : "#d4c9b8",
      })}
    >
      <Icon className="h-4 w-4" />
      {label}
    </NavLink>
  );
}

// ── Layout ─────────────────────────────────────────────────────────

export function Layout() {
  const { connected } = useLiveUpdates();
  const [mobileOpen, setMobileOpen] = useState(false);

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

  const staff = staffData?.staff || [];

  const sidebar = (
    <>
      {/* Header */}
      <div className="px-5 py-5 border-b border-[#2a3040]">
        <h1
          className="text-lg font-bold tracking-wide"
          style={{ color: "#e8dfd0", fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          CarsonOS
        </h1>
        <p
          className="text-[11px] uppercase tracking-[2px] mt-1"
          style={{ color: "#8a8070" }}
        >
          Digital Staff
        </p>
      </div>

      {/* Navigation */}
      <div className="flex-1 py-3 overflow-y-auto">
        {/* Overview section */}
        <div
          className="px-5 pt-2 pb-2 text-[10px] uppercase tracking-[2px]"
          style={{ color: "#5a5a5a" }}
        >
          Overview
        </div>
        <NavItem to="/" icon={LayoutDashboard} label="Dashboard" end />
        <NavItem to="/household" icon={Users} label="Household" />
        <NavItem to="/constitution" icon={ScrollText} label="Constitution" />

        {/* Staff section */}
        {staff.length > 0 && (
          <>
            <div
              className="px-5 pt-5 pb-2 text-[10px] uppercase tracking-[2px]"
              style={{ color: "#5a5a5a" }}
            >
              Staff
            </div>
            {staff.map((agent) => (
              <NavLink
                key={agent.id}
                to={`/staff/${agent.id}`}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 px-5 py-2.5 text-sm border-l-3 border-transparent transition-colors",
                    isActive
                      ? "font-medium"
                      : "hover:bg-[#242a3a]",
                  )
                }
                style={({ isActive }) => ({
                  background: isActive ? "#242a3a" : undefined,
                  borderLeftColor: isActive ? "#8b6f4e" : "transparent",
                  color: isActive ? "#e8dfd0" : "#d4c9b8",
                })}
              >
                <span
                  className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    agent.status === "active"
                      ? "bg-green-500"
                      : agent.status === "paused"
                        ? "bg-orange-400"
                        : "bg-[#5a5a5a]",
                  )}
                />
                {agent.name}
              </NavLink>
            ))}
          </>
        )}

        {/* System section */}
        <div
          className="px-5 pt-5 pb-2 text-[10px] uppercase tracking-[2px]"
          style={{ color: "#5a5a5a" }}
        >
          System
        </div>
        <NavItem to="/conversations" icon={MessageSquare} label="Conversations" />
        <NavItem to="/tasks" icon={ListTodo} label="Tasks" />
        <NavItem to="/schedules" icon={Clock} label="Schedules" />
        <NavItem to="/tools" icon={Wrench} label="Tools" />
        <NavItem to="/projects" icon={FolderGit2} label="Projects" />
        <NavItem to="/settings" icon={Settings} label="Settings" />
      </div>

      {/* Footer: connection status */}
      <div
        className="px-5 py-3 border-t border-[#2a3040] text-xs flex items-center gap-2"
        style={{ color: "#8a8070" }}
      >
        {connected ? (
          <>
            <Wifi className="h-3 w-3 text-green-500" /> Live
          </>
        ) : (
          <>
            <WifiOff className="h-3 w-3 text-red-400" /> Disconnected
          </>
        )}
      </div>
    </>
  );

  return (
    <div className="flex h-screen" style={{ background: "#f5f1eb" }}>
      {/* Desktop sidebar */}
      <nav
        className="hidden md:flex w-[220px] flex-col shrink-0"
        style={{ background: "#1a1f2e" }}
      >
        {sidebar}
      </nav>

      {/* Mobile hamburger */}
      <button
        className="md:hidden fixed top-4 left-4 z-50 p-2 rounded-md"
        style={{ background: "#1a1f2e", color: "#d4c9b8" }}
        onClick={() => setMobileOpen(!mobileOpen)}
      >
        {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <>
          <div
            className="md:hidden fixed inset-0 z-40 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
          <nav
            className="md:hidden fixed inset-y-0 left-0 z-40 w-[220px] flex flex-col"
            style={{ background: "#1a1f2e" }}
          >
            {sidebar}
          </nav>
        </>
      )}

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
