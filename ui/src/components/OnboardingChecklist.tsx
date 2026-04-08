/**
 * OnboardingChecklist -- post-onboarding setup tracker.
 *
 * Computed from server data (GET /api/households/current).
 * Split into Required/Optional sections.
 * Dismissable via localStorage.
 * Shows "Setup: N/6 complete" badge.
 */

import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Check, X, ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface ChecklistItem {
  key: string;
  label: string;
  required: boolean;
  complete: boolean;
}

interface ChecklistData {
  items: ChecklistItem[];
  completedCount: number;
  totalCount: number;
}

const ITEM_LINKS: Record<string, string> = {
  household: "/onboarding",
  constitution: "/constitution",
  profiles: "/household",
  personalities: "/household",
  telegram: "/household",
  assignments: "/household",
};

const STORAGE_KEY = "carsonos-checklist-dismissed";

export function OnboardingChecklist({ checklist }: { checklist: ChecklistData }) {
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "true") setDismissed(true);
  }, []);

  function handleDismiss() {
    setDismissed(true);
    localStorage.setItem(STORAGE_KEY, "true");
  }

  if (dismissed) return null;

  // All complete? Don't show.
  if (checklist.completedCount === checklist.totalCount) return null;

  const required = checklist.items.filter((i) => i.required);
  const optional = checklist.items.filter((i) => !i.required);

  return (
    <div
      className="rounded-lg mb-6"
      style={{ border: "1px solid var(--carson-border)", background: "var(--carson-white)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" style={{ color: "var(--carson-muted)" }} />
          ) : (
            <ChevronRight className="h-4 w-4" style={{ color: "var(--carson-muted)" }} />
          )}
          <span className="text-sm font-semibold" style={{ color: "var(--carson-navy)" }}>
            Getting Started
          </span>
          <Badge
            variant="secondary"
            className="text-[10px] px-2 py-0"
            style={{ background: "var(--carson-navy)", color: "var(--carson-cream)" }}
          >
            Setup: {checklist.completedCount}/{checklist.totalCount} complete
          </Badge>
        </button>
        <button
          onClick={handleDismiss}
          className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5 transition-colors"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" style={{ color: "var(--carson-muted)" }} />
        </button>
      </div>

      {expanded && (
        <div className="px-4 pb-4">
          {/* Required section */}
          {required.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "var(--carson-muted)" }}>
                Required
              </div>
              {required.map((item) => (
                <ChecklistRow key={item.key} item={item} />
              ))}
            </div>
          )}

          {/* Optional section */}
          {optional.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-[1.5px] mb-2" style={{ color: "var(--carson-muted)" }}>
                Optional
              </div>
              {optional.map((item) => (
                <ChecklistRow key={item.key} item={item} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChecklistRow({ item }: { item: ChecklistItem }) {
  const link = ITEM_LINKS[item.key] || "/";

  return (
    <Link
      to={link}
      className="flex items-center gap-3 py-1.5 group hover:opacity-80 transition-opacity"
    >
      <div
        className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
        style={{
          background: item.complete ? "var(--carson-success)" : "var(--carson-border)",
        }}
      >
        {item.complete && <Check className="h-3 w-3 text-white" />}
      </div>
      <span
        className="text-sm"
        style={{
          color: item.complete ? "var(--carson-muted)" : "var(--carson-text)",
          textDecoration: item.complete ? "line-through" : "none",
        }}
      >
        {item.label}
      </span>
    </Link>
  );
}
