import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollText, Edit3, Save, X, Clock, Loader2, RotateCcw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { InterviewOverlay } from "@/components/InterviewOverlay";
import type { ChatMessage } from "@/components/ChatBubble";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── Types ──────────────────────────────────────────────────────────

interface Constitution {
  id: string;
  version: number;
  document: string;
  createdAt: string;
}

interface ConstitutionData {
  constitution: Constitution;
  clauses: unknown[];
}

interface VersionEntry {
  id: string;
  version: number;
  createdAt: string;
  documentPreview: string;
}

const CONSTITUTION_GREETING = "Welcome. I'm Carson, and I'll be heading up your household staff.\n\nBefore we begin, I'll need to learn a bit about your family so I can set things up properly. Let's start with the basics.\n\nWhat are the names and ages of everyone in the household? Parents and children.";

// ── Page ───────────────────────────────────────────────────────────

export function ConstitutionPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [viewingVersion, setViewingVersion] = useState<VersionEntry | null>(null);
  const [showInterview, setShowInterview] = useState(false);
  const [interviewMessages, setInterviewMessages] = useState<ChatMessage[]>([]);

  const { data, isLoading } = useQuery<ConstitutionData>({
    queryKey: ["constitution"],
    queryFn: () => api.get("/constitution"),
    retry: false,
  });

  const { data: versionsData } = useQuery<{ versions: VersionEntry[] }>({
    queryKey: ["constitution", "versions"],
    queryFn: () => api.get("/constitution/versions"),
    enabled: showHistory,
  });

  const saveMutation = useMutation({
    mutationFn: (document: string) =>
      api.put("/constitution/document", { document }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["constitution"] });
      setEditing(false);
    },
  });

  // Interview mutation
  const interviewMutation = useMutation({
    mutationFn: (text: string) =>
      api.post<{ response: string; phase: string; constitutionDocument?: string }>(
        "/constitution/interview",
        { message: text },
      ),
    onSuccess: (data) => {
      setInterviewMessages((prev) => [
        ...prev,
        { role: "assistant" as const, content: data.response },
      ]);
      if (data.constitutionDocument) {
        queryClient.invalidateQueries({ queryKey: ["constitution"] });
      }
    },
  });

  const isInterviewComplete = interviewMutation.data?.constitutionDocument != null;

  const constitution = data?.constitution;

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl">
        <Skeleton className="h-7 w-48 mb-4" />
        <Skeleton className="h-4 w-32 mb-6" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    );
  }

  if (!constitution) {
    return (
      <ConstitutionEmptyState />
    );
  }

  function startEditing() {
    setDraft(constitution!.document);
    setEditing(true);
    setViewingVersion(null);
  }

  function cancelEditing() {
    setEditing(false);
    setDraft("");
  }

  function handleSave() {
    if (draft.trim()) {
      saveMutation.mutate(draft);
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5" style={{ color: "#8b6f4e" }} />
          <h1
            className="text-xl font-normal"
            style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            Family Constitution
          </h1>
          <span className="text-xs ml-2" style={{ color: "#8a8070" }}>
            v{constitution.version}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowHistory(!showHistory)}
            style={{ borderColor: "#ddd5c8", color: showHistory ? "#1a1f2e" : "#8a8070" }}
          >
            <Clock className="h-3.5 w-3.5 mr-1" />
            History
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setInterviewMessages([{ role: "assistant", content: CONSTITUTION_GREETING }]);
              setShowInterview(true);
            }}
            style={{ borderColor: "#ddd5c8", color: "#8a8070" }}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1" />
            Rebuild
          </Button>

          {!editing && !viewingVersion && (
            <Button
              size="sm"
              onClick={startEditing}
              style={{ background: "#1a1f2e", color: "#e8dfd0" }}
            >
              <Edit3 className="h-3.5 w-3.5 mr-1" />
              Edit
            </Button>
          )}
        </div>
      </div>

      <p className="text-sm mb-6" style={{ color: "#8a8070" }}>
        This document governs how all AI staff interact with your family.
      </p>

      {/* Version History Sidebar */}
      {showHistory && versionsData && (
        <div
          className="rounded-lg p-4 mb-6"
          style={{ background: "#faf8f4", border: "1px solid #ddd5c8" }}
        >
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "#8a8070" }}>
            Version History
          </h3>
          <div className="space-y-2">
            {versionsData.versions.map((v) => (
              <button
                key={v.id}
                onClick={() => {
                  setViewingVersion(v);
                  setEditing(false);
                }}
                className="w-full text-left rounded px-3 py-2 text-sm transition-colors hover:bg-white"
                style={{
                  background: viewingVersion?.id === v.id ? "#ffffff" : "transparent",
                  border: viewingVersion?.id === v.id ? "1px solid #ddd5c8" : "1px solid transparent",
                }}
              >
                <span className="font-medium" style={{ color: "#1a1f2e" }}>Version {v.version}</span>
                <span className="text-xs ml-2" style={{ color: "#8a8070" }}>
                  {new Date(v.createdAt).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
          {viewingVersion && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setViewingVersion(null)}
              style={{ borderColor: "#ddd5c8" }}
            >
              Back to current
            </Button>
          )}
        </div>
      )}

      {/* Interview Overlay */}
      <InterviewOverlay
        title="Constitution Builder"
        subtitle="Carson will interview you to build your family constitution"
        isOpen={showInterview}
        onClose={() => {
          setShowInterview(false);
          setInterviewMessages([]);
        }}
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ["constitution"] });
        }}
        messages={interviewMessages}
        isLoading={interviewMutation.isPending}
        isComplete={isInterviewComplete}
        onSendMessage={(text) => {
          setInterviewMessages((prev) => [
            ...prev,
            { role: "user" as const, content: text },
          ]);
          interviewMutation.mutate(text);
        }}
        onReset={() => {
          setInterviewMessages([{ role: "assistant", content: CONSTITUTION_GREETING }]);
        }}
      />

      {/* Document View */}
      <div
        className="rounded-lg"
        style={{ background: "#ffffff", border: "1px solid #ddd5c8" }}
      >
        {editing ? (
          <>
            <div
              className="px-4 py-3 border-b flex items-center justify-between"
              style={{ borderColor: "#eee8dd" }}
            >
              <span className="text-sm font-medium" style={{ color: "#1a1f2e" }}>
                Editing Constitution
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={saveMutation.isPending}
                  style={{ background: "#2e7d32", color: "#fff" }}
                >
                  {saveMutation.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5 mr-1" />
                  )}
                  Save (new version)
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={cancelEditing}
                  style={{ borderColor: "#ddd5c8" }}
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Cancel
                </Button>
              </div>
            </div>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="min-h-[600px] border-0 rounded-none rounded-b-lg text-sm leading-relaxed p-6 resize-none focus-visible:ring-0"
              style={{
                fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', monospace",
                background: "#faf8f4",
                color: "#2c2c2c",
              }}
            />
          </>
        ) : (
          <div className="p-6 lg:p-8">
            <div className="prose prose-sm max-w-none">
              <Markdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => (
                    <h1
                      className="text-xl font-normal mb-4 pb-2 border-b"
                      style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif", borderColor: "#ddd5c8" }}
                    >
                      {children}
                    </h1>
                  ),
                  h2: ({ children }) => (
                    <h2
                      className="text-lg font-normal mt-8 mb-3"
                      style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
                    >
                      {children}
                    </h2>
                  ),
                  h3: ({ children }) => (
                    <h3
                      className="text-base font-semibold mt-6 mb-2"
                      style={{ color: "#1a1f2e" }}
                    >
                      {children}
                    </h3>
                  ),
                  p: ({ children }) => (
                    <p className="mb-3 text-sm leading-relaxed" style={{ color: "#2c2c2c" }}>
                      {children}
                    </p>
                  ),
                  ul: ({ children }) => (
                    <ul className="list-disc ml-5 mb-3 space-y-1 text-sm" style={{ color: "#2c2c2c" }}>
                      {children}
                    </ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="list-decimal ml-5 mb-3 space-y-1 text-sm" style={{ color: "#2c2c2c" }}>
                      {children}
                    </ol>
                  ),
                  li: ({ children }) => (
                    <li className="leading-relaxed">{children}</li>
                  ),
                  strong: ({ children }) => (
                    <strong className="font-semibold" style={{ color: "#1a1f2e" }}>{children}</strong>
                  ),
                  em: ({ children }) => (
                    <em style={{ color: "#6a6050" }}>{children}</em>
                  ),
                  hr: () => (
                    <hr className="my-6" style={{ borderColor: "#ddd5c8" }} />
                  ),
                  blockquote: ({ children }) => (
                    <blockquote
                      className="border-l-2 pl-4 my-4 italic text-sm"
                      style={{ borderColor: "#8b6f4e", color: "#6a6050" }}
                    >
                      {children}
                    </blockquote>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto mb-4">
                      <table className="w-full text-sm border-collapse" style={{ borderColor: "#ddd5c8" }}>
                        {children}
                      </table>
                    </div>
                  ),
                  th: ({ children }) => (
                    <th
                      className="text-left px-3 py-2 border-b font-semibold text-xs uppercase tracking-wider"
                      style={{ borderColor: "#ddd5c8", color: "#8a8070" }}
                    >
                      {children}
                    </th>
                  ),
                  td: ({ children }) => (
                    <td
                      className="px-3 py-2 border-b"
                      style={{ borderColor: "#eee8dd", color: "#2c2c2c" }}
                    >
                      {children}
                    </td>
                  ),
                }}
              >
                {viewingVersion ? viewingVersion.documentPreview : constitution.document}
              </Markdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Empty State — Interview Launcher ──────────────────────────────

function ConstitutionEmptyState() {
  const queryClient = useQueryClient();
  const [showInterview, setShowInterview] = useState(false);
  const [interviewMessages, setInterviewMessages] = useState<ChatMessage[]>([]);

  const interviewMutation = useMutation({
    mutationFn: (text: string) =>
      api.post<{ response: string; phase: string; constitutionDocument?: string }>(
        "/constitution/interview",
        { message: text },
      ),
    onSuccess: (data) => {
      setInterviewMessages((prev) => [
        ...prev,
        { role: "assistant" as const, content: data.response },
      ]);
      if (data.constitutionDocument) {
        queryClient.invalidateQueries({ queryKey: ["constitution"] });
      }
    },
  });

  const isInterviewComplete = interviewMutation.data?.constitutionDocument != null;

  return (
    <div className="p-6 lg:p-8 max-w-4xl">
      <div className="flex items-center gap-2 mb-6">
        <ScrollText className="h-5 w-5" style={{ color: "#8b6f4e" }} />
        <h1
          className="text-xl font-normal"
          style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          Family Constitution
        </h1>
      </div>
      <div
        className="rounded-lg p-8 text-center"
        style={{ background: "#ffffff", border: "1px solid #ddd5c8" }}
      >
        <ScrollText className="h-10 w-10 mx-auto mb-4" style={{ color: "#8b6f4e" }} />
        <h3
          className="text-lg font-normal mb-2"
          style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          Build Your Family Constitution
        </h3>
        <p className="text-sm mb-5 max-w-md mx-auto" style={{ color: "#8a8070" }}>
          Carson will interview you about your family's values, boundaries, and expectations
          to create a constitution that governs how all AI staff interact with your family.
        </p>
        <Button
          size="sm"
          onClick={() => setShowInterview(true)}
          style={{ background: "#1a1f2e", color: "#e8dfd0" }}
        >
          <ScrollText className="h-4 w-4 mr-2" />
          Start Interview
        </Button>
      </div>

      <InterviewOverlay
        title="Constitution Builder"
        subtitle="Carson will interview you to build your family constitution"
        isOpen={showInterview}
        onClose={() => {
          setShowInterview(false);
          setInterviewMessages([]);
        }}
        onComplete={() => {
          queryClient.invalidateQueries({ queryKey: ["constitution"] });
        }}
        messages={interviewMessages}
        isLoading={interviewMutation.isPending}
        isComplete={isInterviewComplete}
        onSendMessage={(text) => {
          setInterviewMessages((prev) => [
            ...prev,
            { role: "user" as const, content: text },
          ]);
          interviewMutation.mutate(text);
        }}
        onReset={() => {
          setInterviewMessages([{ role: "assistant", content: CONSTITUTION_GREETING }]);
        }}
      />
    </div>
  );
}
