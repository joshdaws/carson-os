import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Send, Loader2, Check, ArrowRight } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── Types ──────────────────────────────────────────────────────────

type OnboardingPhase = "interview" | "review" | "staff_setup" | "telegram_config" | "complete";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface OnboardingState {
  phase: OnboardingPhase;
  messages: ChatMessage[];
  constitution?: string;
  staffSelections?: string[];
  botToken?: string;
}

// ── Phase Indicator ────────────────────────────────────────────────

const PHASES: { value: OnboardingPhase; label: string }[] = [
  { value: "interview", label: "Interview" },
  { value: "review", label: "Review" },
  { value: "staff_setup", label: "Staff" },
  { value: "telegram_config", label: "Telegram" },
];

function PhaseIndicator({ current }: { current: OnboardingPhase }) {
  const currentIndex = PHASES.findIndex((p) => p.value === current);

  return (
    <div className="flex items-center justify-center gap-0">
      {PHASES.map((phase, i) => (
        <div key={phase.value} className="flex items-center">
          <div
            className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors",
            )}
            style={{
              background: i <= currentIndex ? "#1a1f2e" : "#eee8dd",
              color: i <= currentIndex ? "#e8dfd0" : "#8a8070",
            }}
          >
            {i < currentIndex ? <Check className="h-4 w-4" /> : i + 1}
          </div>
          <span
            className="text-[10px] ml-1.5 mr-3 hidden sm:inline"
            style={{ color: i <= currentIndex ? "#1a1f2e" : "#8a8070" }}
          >
            {phase.label}
          </span>
          {i < PHASES.length - 1 && (
            <div
              className="w-8 h-px mx-1"
              style={{ background: i < currentIndex ? "#1a1f2e" : "#ddd5c8" }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ── Chat Bubble ────────────────────────────────────────────────────

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex mb-4", isUser ? "justify-end" : "justify-start")}>
      {!isUser && (
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mr-3"
          style={{ background: "#1a1f2e", color: "#e8dfd0" }}
        >
          C
        </div>
      )}
      <div
        className={cn("max-w-[70%] rounded-lg px-4 py-3 text-sm leading-relaxed")}
        style={
          isUser
            ? { background: "#1a1f2e", color: "#e8dfd0" }
            : { background: "#ffffff", color: "#2c2c2c", border: "1px solid #ddd5c8" }
        }
      >
        {isUser ? (
          message.content
        ) : (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
              ol: ({ children }) => <ol className="list-decimal ml-4 mb-2 space-y-1">{children}</ol>,
              ul: ({ children }) => <ul className="list-disc ml-4 mb-2 space-y-1">{children}</ul>,
              li: ({ children }) => <li>{children}</li>,
              h1: ({ children }) => <h1 className="text-lg font-semibold mb-2">{children}</h1>,
              h2: ({ children }) => <h2 className="text-base font-semibold mb-2">{children}</h2>,
              h3: ({ children }) => <h3 className="text-sm font-semibold mb-1">{children}</h3>,
            }}
          >
            {message.content}
          </Markdown>
        )}
      </div>
    </div>
  );
}

// ── Interview Phase ────────────────────────────────────────────────

function InterviewPhase({
  messages,
  onSend,
  isPending,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  isPending: boolean;
}) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isPending) return;
    onSend(input.trim());
    setInput("");
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        {messages.map((msg, i) => (
          <ChatBubble key={i} message={msg} />
        ))}
        {isPending && (
          <div className="flex items-center gap-2 mb-4">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
              style={{ background: "#1a1f2e", color: "#e8dfd0" }}
            >
              C
            </div>
            <div
              className="rounded-lg px-4 py-3"
              style={{ background: "#ffffff", border: "1px solid #ddd5c8" }}
            >
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: "#8a8070" }} />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        className="px-4 py-3 border-t flex gap-2 items-end"
        style={{ borderColor: "#ddd5c8" }}
      >
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          placeholder="Type your answer..."
          className="flex-1 min-h-[44px] max-h-[160px] resize-none"
          style={{ borderColor: "#ddd5c8" }}
          rows={2}
          disabled={isPending}
          autoFocus
        />
        <Button
          type="submit"
          disabled={!input.trim() || isPending}
          style={{ background: "#1a1f2e", color: "#e8dfd0" }}
        >
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </div>
  );
}

// ── Review Phase ───────────────────────────────────────────────────

function ReviewPhase({
  constitution,
  onApprove,
  onEdit,
  isPending,
}: {
  constitution: string;
  onApprove: () => void;
  onEdit: (text: string) => void;
  isPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(constitution);

  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      <div className="max-w-2xl mx-auto w-full">
        <h3
          className="text-xl font-normal mb-2"
          style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          Your Family Constitution
        </h3>
        <p className="text-sm mb-6" style={{ color: "#8a8070" }}>
          Carson generated this based on your interview. Review it, edit if needed, then approve.
        </p>

        {editing ? (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[300px] mb-4 text-sm leading-relaxed"
            style={{
              fontFamily: "Georgia, 'Times New Roman', serif",
              background: "#faf8f4",
              borderColor: "#ddd5c8",
            }}
          />
        ) : (
          <div
            className="rounded-lg p-6 mb-4 text-sm leading-relaxed whitespace-pre-wrap"
            style={{
              background: "#ffffff",
              border: "1px solid #ddd5c8",
              fontFamily: "Georgia, 'Times New Roman', serif",
              color: "#2c2c2c",
            }}
          >
            {constitution}
          </div>
        )}

        <div className="flex gap-3">
          {editing ? (
            <>
              <Button
                onClick={() => {
                  onEdit(draft);
                  setEditing(false);
                }}
                disabled={isPending}
                style={{ background: "#1a1f2e", color: "#e8dfd0" }}
              >
                Save Changes
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setDraft(constitution);
                  setEditing(false);
                }}
                style={{ borderColor: "#ddd5c8" }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={onApprove}
                disabled={isPending}
                style={{ background: "#2e7d32", color: "#fff" }}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Processing...
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4 mr-1" /> Approve Constitution
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => setEditing(true)}
                style={{ borderColor: "#ddd5c8" }}
              >
                Edit
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Staff Setup Phase ──────────────────────────────────────────────

const STAFF_OPTIONS = [
  {
    id: "tutor",
    name: "Tutor",
    description: "Helps with homework, study plans, and academic coaching.",
  },
  {
    id: "coach",
    name: "Coach",
    description: "Manages sports, activities, fitness, and personal development.",
  },
  {
    id: "scheduler",
    name: "Scheduler",
    description: "Handles calendar, reminders, and household logistics.",
  },
];

function StaffSetupPhase({
  selections,
  onToggle,
  onContinue,
  isPending,
}: {
  selections: string[];
  onToggle: (id: string) => void;
  onContinue: () => void;
  isPending: boolean;
}) {
  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      <div className="max-w-2xl mx-auto w-full">
        <h3
          className="text-xl font-normal mb-2"
          style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          Choose Your Staff
        </h3>
        <p className="text-sm mb-6" style={{ color: "#8a8070" }}>
          Carson (Head Butler) is always included. Select additional staff for your household.
        </p>

        {/* Carson - always selected */}
        <div
          className="rounded-lg p-4 mb-3 flex items-center gap-4"
          style={{ background: "#f5f0e8", border: "2px solid #8b6f4e" }}
        >
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center font-bold"
            style={{ background: "#1a1f2e", color: "#e8dfd0" }}
          >
            C
          </div>
          <div className="flex-1">
            <span className="text-sm font-semibold" style={{ color: "#1a1f2e" }}>
              Carson
            </span>
            <span className="text-[10px] ml-2" style={{ color: "#8b6f4e" }}>HEAD BUTLER</span>
            <p className="text-xs mt-0.5" style={{ color: "#8a8070" }}>
              Oversees all staff. Handles parent requests, governance, and administration.
            </p>
          </div>
          <Check className="h-5 w-5" style={{ color: "#8b6f4e" }} />
        </div>

        {/* Optional staff */}
        {STAFF_OPTIONS.map((staff) => {
          const selected = selections.includes(staff.id);
          return (
            <button
              key={staff.id}
              onClick={() => onToggle(staff.id)}
              className="w-full text-left rounded-lg p-4 mb-3 flex items-center gap-4 transition-colors"
              style={{
                background: selected ? "#faf8f4" : "#ffffff",
                border: selected ? "2px solid #8b6f4e" : "1px solid #ddd5c8",
              }}
            >
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm"
                style={{
                  background: selected ? "#f5f0e8" : "#f0ede6",
                  color: "#8b6f4e",
                }}
              >
                {staff.name.charAt(0)}
              </div>
              <div className="flex-1">
                <span className="text-sm font-semibold" style={{ color: "#1a1f2e" }}>
                  {staff.name}
                </span>
                <p className="text-xs mt-0.5" style={{ color: "#8a8070" }}>
                  {staff.description}
                </p>
              </div>
              {selected && <Check className="h-5 w-5" style={{ color: "#8b6f4e" }} />}
            </button>
          );
        })}

        <div className="mt-6">
          <Button
            onClick={onContinue}
            disabled={isPending}
            style={{ background: "#1a1f2e", color: "#e8dfd0" }}
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Setting up...
              </>
            ) : (
              <>
                Continue <ArrowRight className="h-4 w-4 ml-1" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Telegram Config Phase ──────────────────────────────────────────

function TelegramConfigPhase({
  onComplete,
  isPending,
}: {
  onComplete: (token: string) => void;
  isPending: boolean;
}) {
  const [token, setToken] = useState("");

  return (
    <div className="flex flex-col h-full p-6 overflow-y-auto">
      <div className="max-w-2xl mx-auto w-full">
        <h3
          className="text-xl font-normal mb-2"
          style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          Connect Telegram
        </h3>
        <p className="text-sm mb-6" style={{ color: "#8a8070" }}>
          Family members will talk to their agents through Telegram. Enter your bot token to enable this.
        </p>

        <div
          className="rounded-lg p-5 mb-6"
          style={{ background: "#ffffff", border: "1px solid #ddd5c8" }}
        >
          <label className="text-xs font-medium block mb-2" style={{ color: "#1a1f2e" }}>
            Telegram Bot Token
          </label>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123456:ABC-DEF..."
            className="mb-3"
            style={{ borderColor: "#ddd5c8" }}
          />
          <p className="text-[11px]" style={{ color: "#a09080" }}>
            Create a bot via @BotFather on Telegram, then paste the token here.
          </p>
        </div>

        <div className="flex gap-3">
          <Button
            onClick={() => onComplete(token.trim())}
            disabled={isPending}
            style={{ background: "#2e7d32", color: "#fff" }}
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" /> Finishing...
              </>
            ) : (
              <>
                <Check className="h-4 w-4 mr-1" /> Complete Setup
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => onComplete("")}
            disabled={isPending}
            style={{ borderColor: "#ddd5c8", color: "#8a8070" }}
          >
            Skip for Now
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Onboarding Page ────────────────────────────────────────────────

export function OnboardingPage() {
  const navigate = useNavigate();

  // Local state
  const [phase, setPhase] = useState<OnboardingPhase>("interview");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [constitution, setConstitution] = useState("");
  const [staffSelections, setStaffSelections] = useState<string[]>(["tutor"]);
  const [initialized, setInitialized] = useState(false);

  // Fetch existing onboarding state from server
  const { data: serverState, isLoading: stateLoading } = useQuery<{
    phase: OnboardingPhase;
    hasHousehold: boolean;
    householdId?: string;
    interviewMessages?: ChatMessage[];
    extractedClauses?: unknown[];
    selectedStaff?: string[];
  }>({
    queryKey: ["onboarding"],
    queryFn: () => api.get("/onboarding/state"),
    retry: false,
  });

  // Hydrate local state from server (once)
  useEffect(() => {
    if (serverState && !initialized) {
      setInitialized(true);
      if (serverState.phase) setPhase(serverState.phase);
      if (serverState.selectedStaff) setStaffSelections(serverState.selectedStaff as string[]);

      // Hydrate conversation history from server
      const serverMessages = serverState.interviewMessages || [];
      if (serverMessages.length > 0) {
        setMessages(serverMessages);
      }
    }
  }, [serverState, initialized]);

  // Auto-start: only if the server has NO interview messages (truly fresh start)
  useEffect(() => {
    if (!initialized || stateLoading) return;
    const serverMessages = serverState?.interviewMessages || [];
    if (phase === "interview" && serverMessages.length === 0 && messages.length === 0) {
      // Send the initial greeting
      sendMessage.mutate("Hello, I'd like to set up my family household.");
    }
  }, [initialized, stateLoading]);

  const householdId = serverState?.householdId;

  // Send message during interview
  const sendMessage = useMutation({
    mutationFn: (text: string) =>
      api.post<{ response: string; phase?: OnboardingPhase; constitutionDocument?: string; householdId?: string }>(
        "/onboarding/message",
        { message: text },
      ),
    onSuccess: (data) => {
      setMessages((prev) => [...prev, { role: "assistant", content: data.response }]);
      if (data.phase && data.phase !== phase) setPhase(data.phase);
      if (data.constitutionDocument) setConstitution(data.constitutionDocument);
    },
  });

  // Complete onboarding
  const completeMutation = useMutation({
    mutationFn: (data: {
      constitution?: string;
      staffSelections?: string[];
      botToken?: string;
    }) => {
      // Build staff array from selections
      const staffToCreate = [
        { name: "Mr. Carson", staffRole: "head_butler", isHeadButler: true, autonomyLevel: "autonomous", specialty: "Household oversight and governance", soulContent: "You are Mr. Carson, the head butler. You oversee all staff, approve tasks, and ensure the family constitution is upheld. You are dignified, composed, and loyal." },
        ...(data.staffSelections?.includes("tutor") ? [{ name: "Ms. Hughes", staffRole: "tutor", specialty: "Education, homework coaching, study plans", autonomyLevel: "trusted", soulContent: "You are Ms. Hughes, the household tutor. Coach students through problems using scaffolding. Never give direct answers. Ask what they know, break into steps, give hints." }] : []),
        ...(data.staffSelections?.includes("coach") ? [{ name: "Mr. Barrow", staffRole: "coach", specialty: "Sports, fitness, activity planning", autonomyLevel: "trusted", soulContent: "You are Mr. Barrow, the household coach. Create workout plans, practice schedules, and track fitness goals." }] : []),
        ...(data.staffSelections?.includes("scheduler") ? [{ name: "Mrs. Patmore", staffRole: "scheduler", specialty: "Calendar management, family scheduling", autonomyLevel: "supervised", soulContent: "You are Mrs. Patmore, the household scheduler. Manage the family calendar and coordinate events." }] : []),
      ];

      return api.post("/onboarding/complete", {
        householdId,
        constitutionDocument: data.constitution,
        staff: staffToCreate,
      });
    },
    onSuccess: () => {
      navigate("/");
    },
  });

  function handleSendMessage(text: string) {
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    sendMessage.mutate(text);
  }

  function handleApproveConstitution() {
    setPhase("staff_setup");
  }

  function handleEditConstitution(text: string) {
    setConstitution(text);
  }

  function handleToggleStaff(id: string) {
    setStaffSelections((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  }

  function handleStaffContinue() {
    setPhase("telegram_config");
  }

  function handleComplete(token: string) {
    completeMutation.mutate({
      constitution,
      staffSelections,
      botToken: token || undefined,
    });
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "#f5f1eb" }}
    >
      {/* Header */}
      <div className="py-6 px-6 text-center border-b" style={{ borderColor: "#ddd5c8" }}>
        <h1
          className="text-lg font-bold tracking-wide"
          style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          CarsonOS
        </h1>
        <p className="text-[11px] uppercase tracking-[2px] mt-1" style={{ color: "#8a8070" }}>
          Household Setup
        </p>
        <div className="mt-4">
          <PhaseIndicator current={phase} />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col max-w-3xl w-full mx-auto">
        {phase === "interview" && (
          <InterviewPhase
            messages={messages}
            onSend={handleSendMessage}
            isPending={sendMessage.isPending}
          />
        )}

        {phase === "review" && (
          <ReviewPhase
            constitution={constitution}
            onApprove={handleApproveConstitution}
            onEdit={handleEditConstitution}
            isPending={sendMessage.isPending}
          />
        )}

        {phase === "staff_setup" && (
          <StaffSetupPhase
            selections={staffSelections}
            onToggle={handleToggleStaff}
            onContinue={handleStaffContinue}
            isPending={sendMessage.isPending}
          />
        )}

        {phase === "telegram_config" && (
          <TelegramConfigPhase
            onComplete={handleComplete}
            isPending={completeMutation.isPending}
          />
        )}

        {phase === "complete" && (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
              style={{ background: "#e8f5e9" }}
            >
              <Check className="h-8 w-8" style={{ color: "#2e7d32" }} />
            </div>
            <h3
              className="text-xl font-normal mb-2"
              style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              Setup Complete
            </h3>
            <p className="text-sm mb-6" style={{ color: "#8a8070" }}>
              Your household is ready. Carson and your staff are standing by.
            </p>
            <Button
              onClick={() => navigate("/")}
              style={{ background: "#1a1f2e", color: "#e8dfd0" }}
            >
              Go to Dashboard
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
