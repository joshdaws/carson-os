/**
 * StepCounter -- navy pill with cream text showing "Question N of 7"
 * and a 2px progress bar beneath.
 *
 * Only rendered during Phase 2 of the interview (values through escalation).
 */

export function StepCounter({
  questionNumber,
  totalQuestions,
}: {
  questionNumber: number;
  totalQuestions: number;
}) {
  const progressPct = (questionNumber / totalQuestions) * 100;

  return (
    <div className="inline-flex flex-col items-center">
      <div
        className="rounded-full px-4 flex items-center justify-center text-xs font-medium"
        style={{
          height: "32px",
          background: "var(--carson-navy)",
          color: "var(--carson-cream)",
        }}
      >
        Question {questionNumber} of {totalQuestions}
      </div>
      <div
        className="w-full rounded-full overflow-hidden mt-1"
        style={{ height: "2px", background: "var(--carson-border)" }}
      >
        <div
          className="h-full rounded-full transition-all duration-300 ease-out"
          style={{
            width: `${progressPct}%`,
            background: "var(--carson-navy)",
          }}
        />
      </div>
    </div>
  );
}
