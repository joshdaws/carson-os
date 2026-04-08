/**
 * MissionRevealCard -- displays the family's mission statement with
 * Instrument Serif font, warm ivory background, fade-in animation.
 *
 * Appears after Carson's lead-in: "And here is what it all comes down to."
 * 1s delay before reveal for dramatic timing.
 */

import { useState, useEffect } from "react";

export function MissionRevealCard({
  missionStatement,
  animated = true,
}: {
  missionStatement: string;
  animated?: boolean;
}) {
  const [visible, setVisible] = useState(!animated);

  useEffect(() => {
    if (!animated) return;
    const timer = setTimeout(() => setVisible(true), 1000);
    return () => clearTimeout(timer);
  }, [animated]);

  return (
    <div
      className="rounded-lg p-6 transition-all duration-500 ease-out"
      style={{
        background: "var(--carson-ivory)",
        border: "1px solid var(--carson-border)",
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(8px)",
      }}
    >
      <p
        className="text-lg leading-relaxed text-center italic"
        style={{
          fontFamily: "'Instrument Serif', Georgia, serif",
          color: "var(--carson-text)",
        }}
      >
        {missionStatement}
      </p>
    </div>
  );
}
