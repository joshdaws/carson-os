/**
 * ProfileEditModal — view + edit a member's USER.md as raw markdown.
 *
 * Loads the current profile via GET /members/:id/profile (disk-first,
 * DB fallback) and saves via PUT — which mirrors back to USER.md.
 * Stateless from the parent's perspective: open with a memberId, close
 * via onClose.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, X } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface ProfileEditModalProps {
  memberId: string | null;
  memberName: string;
  onClose: () => void;
}

interface ProfileResponse {
  memberId: string;
  memberName: string;
  profileContent: string | null;
  profileUpdatedAt: string | null;
}

export function ProfileEditModal({
  memberId,
  memberName,
  onClose,
}: ProfileEditModalProps) {
  const isOpen = !!memberId;
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data, isLoading } = useQuery<ProfileResponse>({
    queryKey: ["profile", memberId],
    queryFn: () => api.get(`/members/${memberId}/profile`),
    enabled: isOpen,
    staleTime: 0,
  });

  // Sync server content into the draft when it first loads. Avoid
  // clobbering local edits if data refetches.
  useEffect(() => {
    if (!isOpen) return;
    if (data && !dirty) {
      setDraft(data.profileContent ?? "");
    }
  }, [data, isOpen, dirty]);

  // Reset state on close
  useEffect(() => {
    if (!isOpen) {
      setDraft("");
      setDirty(false);
    }
  }, [isOpen]);

  // Escape closes
  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  const saveMutation = useMutation({
    mutationFn: (content: string) =>
      api.put(`/members/${memberId}/profile`, { profileContent: content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile", memberId] });
      queryClient.invalidateQueries({ queryKey: ["household"] });
      setDirty(false);
      onClose();
    },
  });

  if (!isOpen) return null;

  function handleSave() {
    if (saveMutation.isPending) return;
    saveMutation.mutate(draft);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(26, 31, 46, 0.6)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex flex-col w-full max-w-2xl rounded-lg overflow-hidden"
        style={{
          maxHeight: "85vh",
          background: "var(--carson-ivory, #faf8f4)",
          border: "1px solid var(--carson-border, #ddd5c8)",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
        }}
      >
        {/* Header */}
        <div
          className="px-5 py-4 flex items-center justify-between border-b shrink-0"
          style={{ borderColor: "#ddd5c8", background: "#ffffff" }}
        >
          <div>
            <h3 className="text-base font-normal font-serif text-carson-text-primary">
              Profile: {memberName}
            </h3>
            <p className="text-xs mt-0.5" style={{ color: "#6b6358" }}>
              Edits write to USER.md on disk
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={onClose}
            title="Close"
          >
            <X className="h-4 w-4" style={{ color: "#6b6358" }} />
          </Button>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm" style={{ color: "#6b6358" }}>
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading profile...
            </div>
          ) : (
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setDirty(true);
              }}
              placeholder="# About Member&#10;&#10;Write or paste markdown here..."
              className="w-full min-h-[400px] font-mono text-sm leading-relaxed resize-y"
              style={{ borderColor: "#ddd5c8" }}
              spellCheck={false}
            />
          )}
        </div>

        {/* Footer */}
        <div
          className="px-5 py-4 border-t flex items-center justify-between shrink-0"
          style={{ borderColor: "#ddd5c8", background: "#ffffff" }}
        >
          <div className="text-xs" style={{ color: "#6b6358" }}>
            {saveMutation.isError && (
              <span style={{ color: "#b3261e" }}>
                Save failed: {(saveMutation.error as Error).message}
              </span>
            )}
            {!saveMutation.isError && dirty && <span>Unsaved changes</span>}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saveMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending || isLoading || !dirty}
              style={{ background: "#1a1f2e", color: "#e8dfd0" }}
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
