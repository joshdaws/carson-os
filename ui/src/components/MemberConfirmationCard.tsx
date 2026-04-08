/**
 * MemberConfirmationCard -- CRUD table for confirming family members during onboarding.
 *
 * Features:
 * - Inline editing (pencil icon per row)
 * - Delete (trash icon per row)
 * - +Add Member row
 * - "Confirm Family" primary button
 * - Locks to read-only after confirmation
 * - Mobile (<640px): vertical card stack instead of table
 * - 44px touch targets on pencil/trash icons
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pencil, Trash2, Plus, Check, Loader2 } from "lucide-react";
import type { MemberRole } from "@carsonos/shared";

interface MemberRow {
  name: string;
  age: number;
  role: MemberRole;
}

export function MemberConfirmationCard({
  initialMembers,
  confirmed: initialConfirmed,
  householdId,
  onConfirmed,
}: {
  initialMembers: MemberRow[];
  confirmed: boolean;
  householdId: string;
  onConfirmed?: (members: MemberRow[]) => void;
}) {
  const [members, setMembers] = useState<MemberRow[]>(initialMembers);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<MemberRow>({ name: "", age: 0, role: "kid" });
  const [confirmed, setConfirmed] = useState(initialConfirmed);

  const confirmMutation = useMutation({
    mutationFn: () =>
      api.post<{ members: unknown[] }>("/onboarding/confirm-members", {
        householdId,
        members,
      }),
    onSuccess: () => {
      setConfirmed(true);
      onConfirmed?.(members);
    },
  });

  function startEdit(index: number) {
    if (confirmed) return;
    setEditingIndex(index);
    setEditDraft({ ...members[index] });
  }

  function saveEdit() {
    if (editingIndex === null) return;
    setMembers((prev) => prev.map((m, i) => (i === editingIndex ? { ...editDraft } : m)));
    setEditingIndex(null);
  }

  function cancelEdit() {
    setEditingIndex(null);
  }

  function deleteMember(index: number) {
    if (confirmed) return;
    setMembers((prev) => prev.filter((_, i) => i !== index));
    if (editingIndex === index) setEditingIndex(null);
  }

  function addMember() {
    if (confirmed) return;
    const newMember: MemberRow = { name: "", age: 0, role: "kid" };
    setMembers((prev) => [...prev, newMember]);
    setEditingIndex(members.length);
    setEditDraft(newMember);
  }

  function inferRole(age: number): MemberRole {
    if (age >= 18) return "parent";
    return "kid";
  }

  // ── Read-only row ──────────────────────────────────────────
  function ReadOnlyRow({ member, index }: { member: MemberRow; index: number }) {
    const roleLabel = member.role === "parent" ? "Parent" : "Kid";

    return (
      <>
        {/* Desktop row */}
        <tr className="hidden sm:table-row" style={{ borderBottom: "1px solid var(--carson-border)" }}>
          <td className="py-2 pr-3 text-sm" style={{ color: confirmed ? "var(--carson-muted)" : "var(--carson-text)" }}>
            {member.name}
          </td>
          <td className="py-2 pr-3 text-sm" style={{ color: confirmed ? "var(--carson-muted)" : "var(--carson-text)" }}>
            {member.age}
          </td>
          <td className="py-2 pr-3 text-sm" style={{ color: confirmed ? "var(--carson-muted)" : "var(--carson-text)" }}>
            {roleLabel}
          </td>
          {!confirmed && (
            <td className="py-2 text-right">
              <div className="flex gap-1 justify-end">
                <button
                  onClick={() => startEdit(index)}
                  className="w-[44px] h-[44px] flex items-center justify-center rounded hover:bg-black/5 transition-colors"
                  title="Edit"
                >
                  <Pencil className="h-4 w-4" style={{ color: "var(--carson-muted)" }} />
                </button>
                <button
                  onClick={() => deleteMember(index)}
                  className="w-[44px] h-[44px] flex items-center justify-center rounded hover:bg-black/5 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" style={{ color: "var(--carson-error)" }} />
                </button>
              </div>
            </td>
          )}
        </tr>

        {/* Mobile card */}
        <div
          className="sm:hidden rounded-lg p-3 mb-2"
          style={{ border: "1px solid var(--carson-border)", background: "var(--carson-white)" }}
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium" style={{ color: confirmed ? "var(--carson-muted)" : "var(--carson-text)" }}>
                {member.name}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--carson-muted)" }}>
                Age {member.age} &middot; {roleLabel}
              </div>
            </div>
            {!confirmed && (
              <div className="flex gap-1">
                <button
                  onClick={() => startEdit(index)}
                  className="w-[44px] h-[44px] flex items-center justify-center rounded hover:bg-black/5"
                  title="Edit"
                >
                  <Pencil className="h-4 w-4" style={{ color: "var(--carson-muted)" }} />
                </button>
                <button
                  onClick={() => deleteMember(index)}
                  className="w-[44px] h-[44px] flex items-center justify-center rounded hover:bg-black/5"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" style={{ color: "var(--carson-error)" }} />
                </button>
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // ── Editing row ────────────────────────────────────────────
  function EditingRow() {
    return (
      <>
        {/* Desktop editing row */}
        <tr className="hidden sm:table-row" style={{ borderBottom: "1px solid var(--carson-border)" }}>
          <td className="py-2 pr-2">
            <Input
              value={editDraft.name}
              onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Name"
              className="text-sm h-9"
              style={{ borderColor: "var(--carson-border)" }}
              autoFocus
            />
          </td>
          <td className="py-2 pr-2">
            <Input
              type="number"
              value={editDraft.age || ""}
              onChange={(e) => {
                const age = parseInt(e.target.value, 10) || 0;
                setEditDraft((d) => ({ ...d, age, role: inferRole(age) }));
              }}
              placeholder="Age"
              className="text-sm h-9 w-20"
              style={{ borderColor: "var(--carson-border)" }}
            />
          </td>
          <td className="py-2 pr-2">
            <select
              value={editDraft.role}
              onChange={(e) => setEditDraft((d) => ({ ...d, role: e.target.value as MemberRole }))}
              className="text-sm h-9 rounded border px-2"
              style={{ borderColor: "var(--carson-border)", color: "var(--carson-text)" }}
            >
              <option value="parent">Parent</option>
              <option value="kid">Kid</option>
            </select>
          </td>
          <td className="py-2 text-right">
            <div className="flex gap-1 justify-end">
              <Button
                size="sm"
                onClick={saveEdit}
                disabled={!editDraft.name.trim()}
                style={{ background: "var(--carson-navy)", color: "var(--carson-cream)" }}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={cancelEdit}
                style={{ borderColor: "var(--carson-border)" }}
              >
                Cancel
              </Button>
            </div>
          </td>
        </tr>

        {/* Mobile editing card */}
        <div
          className="sm:hidden rounded-lg p-3 mb-2 space-y-2"
          style={{ border: "1px solid var(--carson-navy)", background: "var(--carson-white)" }}
        >
          <Input
            value={editDraft.name}
            onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Name"
            className="text-sm"
            style={{ borderColor: "var(--carson-border)" }}
            autoFocus
          />
          <div className="flex gap-2">
            <Input
              type="number"
              value={editDraft.age || ""}
              onChange={(e) => {
                const age = parseInt(e.target.value, 10) || 0;
                setEditDraft((d) => ({ ...d, age, role: inferRole(age) }));
              }}
              placeholder="Age"
              className="text-sm w-20"
              style={{ borderColor: "var(--carson-border)" }}
            />
            <select
              value={editDraft.role}
              onChange={(e) => setEditDraft((d) => ({ ...d, role: e.target.value as MemberRole }))}
              className="text-sm rounded border px-2 flex-1"
              style={{ borderColor: "var(--carson-border)", color: "var(--carson-text)" }}
            >
              <option value="parent">Parent</option>
              <option value="kid">Kid</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={saveEdit}
              disabled={!editDraft.name.trim()}
              className="flex-1"
              style={{ background: "var(--carson-navy)", color: "var(--carson-cream)" }}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={cancelEdit}
              className="flex-1"
              style={{ borderColor: "var(--carson-border)" }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </>
    );
  }

  return (
    <div>
      {/* Desktop table */}
      <table className="w-full hidden sm:table">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--carson-border)" }}>
            <th className="text-left text-xs font-medium py-1.5 pr-3" style={{ color: "var(--carson-muted)" }}>Name</th>
            <th className="text-left text-xs font-medium py-1.5 pr-3" style={{ color: "var(--carson-muted)" }}>Age</th>
            <th className="text-left text-xs font-medium py-1.5 pr-3" style={{ color: "var(--carson-muted)" }}>Role</th>
            {!confirmed && <th className="w-24" />}
          </tr>
        </thead>
        <tbody>
          {members.map((member, i) =>
            editingIndex === i ? (
              <EditingRow key={i} />
            ) : (
              <ReadOnlyRow key={i} member={member} index={i} />
            ),
          )}
        </tbody>
      </table>

      {/* Mobile cards */}
      <div className="sm:hidden">
        {members.map((member, i) =>
          editingIndex === i ? (
            <EditingRow key={i} />
          ) : (
            <ReadOnlyRow key={i} member={member} index={i} />
          ),
        )}
      </div>

      {/* Add member + Confirm */}
      {!confirmed && (
        <div className="mt-3 flex items-center justify-between">
          <button
            onClick={addMember}
            className="text-sm flex items-center gap-1.5 hover:opacity-80 transition-opacity"
            style={{ color: "var(--carson-muted)" }}
          >
            <Plus className="h-3.5 w-3.5" />
            Add Member
          </button>

          <Button
            onClick={() => confirmMutation.mutate()}
            disabled={members.length === 0 || confirmMutation.isPending || editingIndex !== null}
            style={{ background: "var(--carson-navy)", color: "var(--carson-cream)" }}
          >
            {confirmMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> Confirming...
              </>
            ) : (
              "Confirm Family"
            )}
          </Button>
        </div>
      )}

      {/* Confirmed state */}
      {confirmed && (
        <div className="mt-3 flex items-center gap-2" style={{ color: "var(--carson-success)" }}>
          <Check className="h-4 w-4" />
          <span className="text-sm font-medium">Family confirmed</span>
        </div>
      )}
    </div>
  );
}
