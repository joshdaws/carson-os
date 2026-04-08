/**
 * ConstitutionLoading -- phased loading messages for constitution generation.
 *
 * 3 stages with 300ms entrance timing:
 * 1. "Reviewing your values..."
 * 2. "Drafting governance clauses..."
 * 3. "Composing your family mission..."
 */

import { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";

const STAGES = [
  "Reviewing your values...",
  "Drafting governance clauses...",
  "Composing your family mission...",
];

export function ConstitutionLoading() {
  const [visibleStages, setVisibleStages] = useState<number[]>([]);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    STAGES.forEach((_, i) => {
      timers.push(
        setTimeout(() => {
          setVisibleStages((prev) => [...prev, i]);
        }, i * 300),
      );
    });
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="space-y-2">
      {STAGES.map((text, i) => (
        <div
          key={i}
          className="flex items-center gap-2 text-sm transition-all duration-300 ease-out"
          style={{
            color: "var(--carson-muted)",
            opacity: visibleStages.includes(i) ? 1 : 0,
            transform: visibleStages.includes(i) ? "translateY(0)" : "translateY(4px)",
          }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}
