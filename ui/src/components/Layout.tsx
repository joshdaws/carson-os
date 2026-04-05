import { Outlet, NavLink } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useLiveUpdates } from "@/context/LiveUpdatesProvider";
import {
  LayoutDashboard,
  Users,
  ScrollText,
  MessageSquare,
  DollarSign,
  Settings,
  Wifi,
  WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FamilyMember {
  id: string;
  name: string;
  role: string;
  agent?: { id: string; status: string };
}

interface FamilyData {
  family: { id: string; name: string };
  members: FamilyMember[];
}

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
          "flex items-center gap-3 px-4 py-2 text-sm border-l-3 border-transparent transition-colors",
          isActive
            ? "bg-secondary text-foreground border-l-foreground font-medium"
            : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
        )
      }
    >
      <Icon className="h-4 w-4" />
      {label}
    </NavLink>
  );
}

export function Layout() {
  const { connected } = useLiveUpdates();

  const { data } = useQuery<FamilyData>({
    queryKey: ["family"],
    queryFn: () => api.get("/families/current"),
    retry: false,
  });

  return (
    <div className="flex h-screen">
      <nav className="w-60 border-r bg-card flex flex-col shrink-0">
        <div className="px-4 py-4 border-b">
          <h1 className="text-base font-bold tracking-tight">CarsonOS</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {data?.family.name || "Loading..."}
          </p>
        </div>

        <div className="flex-1 py-2 overflow-y-auto">
          <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Overview
          </div>
          <NavItem to="/" icon={LayoutDashboard} label="Dashboard" end />
          <NavItem to="/family" icon={Users} label="Family" />
          <NavItem to="/constitution" icon={ScrollText} label="Constitution" />

          {data?.members && data.members.length > 0 && (
            <>
              <div className="px-4 pt-4 pb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                Agents
              </div>
              {data.members.map((m) => (
                <NavLink
                  key={m.id}
                  to={m.agent ? `/agents/${m.agent.id}` : "#"}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-3 px-4 py-2 text-sm border-l-3 border-transparent transition-colors",
                      isActive
                        ? "bg-secondary text-foreground border-l-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/50",
                    )
                  }
                >
                  <span
                    className={cn(
                      "w-2 h-2 rounded-full",
                      m.agent?.status === "active"
                        ? "bg-green-500"
                        : "bg-muted-foreground/30",
                    )}
                  />
                  {m.name}
                </NavLink>
              ))}
            </>
          )}

          <div className="px-4 pt-4 pb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            System
          </div>
          <NavItem to="/conversations" icon={MessageSquare} label="Conversations" />
          <NavItem to="/budget" icon={DollarSign} label="Budget" />
          <NavItem to="/settings" icon={Settings} label="Settings" />
        </div>

        <div className="px-4 py-3 border-t text-xs text-muted-foreground flex items-center gap-2">
          {connected ? (
            <>
              <Wifi className="h-3 w-3 text-green-500" /> Live
            </>
          ) : (
            <>
              <WifiOff className="h-3 w-3 text-destructive" /> Disconnected
            </>
          )}
        </div>
      </nav>

      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
