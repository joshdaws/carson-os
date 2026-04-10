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
import { Check, X, ChevronDown, ChevronRight, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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
  google: "__help__",
};

const STORAGE_KEY = "carsonos-checklist-dismissed";

export function OnboardingChecklist({ checklist }: { checklist: ChecklistData }) {
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [showGoogleHelp, setShowGoogleHelp] = useState(false);

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
                <ChecklistRow key={item.key} item={item} onGoogleHelp={() => setShowGoogleHelp(true)} />
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
                <ChecklistRow key={item.key} item={item} onGoogleHelp={() => setShowGoogleHelp(true)} />
              ))}
            </div>
          )}

          {/* Google Help Overlay */}
          {showGoogleHelp && <GoogleHelpOverlay onClose={() => setShowGoogleHelp(false)} />}
        </div>
      )}
    </div>
  );
}

function ChecklistRow({ item, onGoogleHelp }: { item: ChecklistItem; onGoogleHelp: () => void }) {
  const link = ITEM_LINKS[item.key] || "/";
  const isHelpLink = link === "__help__";

  const content = (
    <>
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
      {isHelpLink && !item.complete && (
        <HelpCircle className="h-3.5 w-3.5 ml-auto shrink-0" style={{ color: "var(--carson-muted)" }} />
      )}
    </>
  );

  if (isHelpLink) {
    return (
      <button
        onClick={onGoogleHelp}
        className="flex items-center gap-3 py-1.5 w-full text-left group hover:opacity-80 transition-opacity"
      >
        {content}
      </button>
    );
  }

  return (
    <Link
      to={link}
      className="flex items-center gap-3 py-1.5 group hover:opacity-80 transition-opacity"
    >
      {content}
    </Link>
  );
}

// ── Google Setup Help Overlay ──────────────────────────────────────

function GoogleHelpOverlay({ onClose }: { onClose: () => void }) {
  // Close on escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(26, 31, 46, 0.6)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-lg overflow-hidden"
        style={{
          background: "#ffffff",
          border: "1px solid var(--carson-border, #ddd5c8)",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        }}
      >
        <div className="px-5 py-4 flex items-center justify-between border-b" style={{ borderColor: "#ddd5c8" }}>
          <h3
            className="text-base font-normal"
            style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            Connect Google Services
          </h3>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded hover:bg-black/5">
            <X className="h-4 w-4" style={{ color: "#6b6358" }} />
          </button>
        </div>

        <div className="px-5 py-5 space-y-4">
          <p className="text-sm" style={{ color: "#2c2c2c" }}>
            Google Calendar, Gmail, and Drive integration requires a one-time authentication per family member.
          </p>

          <div className="space-y-3">
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: "#1a1f2e" }}>
                1. Set up Google Cloud credentials
              </p>
              <p className="text-xs" style={{ color: "#8a8070" }}>
                Create a project at{" "}
                <span className="font-mono text-[11px]" style={{ color: "#5a5040" }}>
                  console.cloud.google.com
                </span>
                , enable Calendar, Gmail, and Drive APIs, then download your OAuth credentials.
              </p>
            </div>

            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: "#1a1f2e" }}>
                2. Copy credentials for each member
              </p>
              <pre
                className="text-[11px] p-3 rounded overflow-x-auto"
                style={{
                  fontFamily: "ui-monospace, monospace",
                  background: "#faf8f4",
                  color: "#2c2c2c",
                  border: "1px solid #eee8dd",
                }}
              >
{`mkdir -p ~/.carsonos/google/your-name
cp credentials.json ~/.carsonos/google/your-name/client_secret.json`}
              </pre>
            </div>

            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: "#1a1f2e" }}>
                3. Authenticate
              </p>
              <pre
                className="text-[11px] p-3 rounded overflow-x-auto"
                style={{
                  fontFamily: "ui-monospace, monospace",
                  background: "#faf8f4",
                  color: "#2c2c2c",
                  border: "1px solid #eee8dd",
                }}
              >
{`GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.carsonos/google/your-name \\
  gws auth login`}
              </pre>
            </div>
          </div>

          <p className="text-xs" style={{ color: "#a09080" }}>
            Each family member authenticates separately with their own Google account.
            Restart the CarsonOS server after authenticating.
          </p>

          <div className="flex justify-end pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              style={{ borderColor: "#ddd5c8" }}
            >
              Got it
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
