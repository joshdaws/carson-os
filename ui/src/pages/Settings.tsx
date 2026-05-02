import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Settings as SettingsIcon,
  Bot,
  Users,
  Eye,
  EyeOff,
  Save,
  Check,
  Mic,
  Pencil,
  Trash2,
  RotateCcw,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

interface SettingsMap {
  [key: string]: string;
}

interface SettingsResponse {
  settings: SettingsMap;
  savedSecretKeys?: string[];
}

type AdapterType = "claude-code" | "codex" | "anthropic-sdk";
type SecretSettingKey = "ANTHROPIC_API_KEY" | "GROQ_API_KEY";

// ── Constants ──────────────────────────────────────────────────────

const ADAPTER_OPTIONS: { value: AdapterType; label: string; description: string }[] = [
  { value: "claude-code", label: "Claude Code", description: "Subprocess adapter using Claude Code CLI" },
  { value: "codex", label: "Codex", description: "OpenAI Codex CLI adapter" },
  { value: "anthropic-sdk", label: "Anthropic SDK", description: "Direct API calls via Anthropic SDK" },
];

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Phoenix",
  "America/Toronto",
  "America/Vancouver",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Australia/Sydney",
  "UTC",
];

// ── Sub-components ─────────────────────────────────────────────────

function SettingSection({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <Card className="border mb-4" style={{ borderColor: "#ddd5c8" }}>
      <div
        className="px-4 py-3 border-b flex items-center gap-2"
        style={{ borderColor: "#eee8dd" }}
      >
        <Icon className="h-4 w-4 text-[#8a8070]" />
        <h3 className="text-sm font-semibold" style={{ color: "#1a1f2e" }}>
          {title}
        </h3>
      </div>
      <CardContent className="p-4 pt-4 space-y-4">{children}</CardContent>
    </Card>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  placeholder,
  hasSavedValue = false,
  isDirty = false,
  onClearSaved,
  onCancelChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hasSavedValue?: boolean;
  isDirty?: boolean;
  onClearSaved?: () => void;
  onCancelChange?: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const canReveal = value.length > 0;
  const showSavedState = hasSavedValue && !isDirty && !replacing;
  const markedForClear = hasSavedValue && isDirty && value.length === 0;
  const showInput = !showSavedState && !markedForClear;

  const cancelChange = () => {
    setVisible(false);
    setReplacing(false);
    onCancelChange?.();
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <label className="text-xs font-medium" style={{ color: "#5a5a5a" }}>
          {label}
        </label>
        {showSavedState && (
          <span className="inline-flex items-center gap-1 text-[11px]" style={{ color: "#2e7d32" }}>
            <Check className="h-3 w-3" /> Saved
          </span>
        )}
      </div>

      {showSavedState && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div
            className="h-9 flex-1 rounded-md border px-3 flex items-center justify-between"
            style={{ borderColor: "#ddd5c8", background: "#faf8f4" }}
          >
            <span className="text-sm tracking-[0.18em]" style={{ color: "#8a8070" }}>
              •••• •••• ••••
            </span>
            <span className="text-[11px]" style={{ color: "#7a7060" }}>
              hidden
            </span>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 text-xs"
              style={{ borderColor: "#ddd5c8" }}
              onClick={() => setReplacing(true)}
            >
              <Pencil className="h-3.5 w-3.5 mr-1" /> Replace
            </Button>
            {onClearSaved && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 text-xs"
                style={{ borderColor: "#ead2c8", color: "#8a3a28" }}
                onClick={() => {
                  setVisible(false);
                  setReplacing(false);
                  onClearSaved();
                }}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Clear
              </Button>
            )}
          </div>
        </div>
      )}

      {markedForClear && (
        <div
          className="rounded-md border px-3 py-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          style={{ borderColor: "#ead2c8", background: "#fff8f5" }}
        >
          <div>
            <p className="text-xs font-medium" style={{ color: "#8a3a28" }}>
              Saved key will be cleared when you save changes.
            </p>
            <p className="text-[11px]" style={{ color: "#9a6b5e" }}>
              The current key remains active until Save.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs self-start sm:self-auto"
            style={{ borderColor: "#ead2c8" }}
            onClick={cancelChange}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Undo
          </Button>
        </div>
      )}

      {showInput && (
        <div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                type={visible ? "text" : "password"}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={hasSavedValue ? "Paste replacement key" : placeholder}
                className="pr-9"
                style={{ borderColor: "#ddd5c8" }}
                autoComplete="new-password"
                spellCheck={false}
              />
              {canReveal && (
                <button
                  type="button"
                  onClick={() => setVisible(!visible)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2"
                  style={{ color: "#8a8070" }}
                  aria-label={visible ? "Hide value" : "Show value"}
                >
                  {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              )}
            </div>
            {hasSavedValue && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-9 text-xs"
                style={{ borderColor: "#ddd5c8" }}
                onClick={cancelChange}
              >
                Cancel
              </Button>
            )}
          </div>
          {hasSavedValue && (
            <p className="text-[11px] mt-1.5" style={{ color: "#7a7060" }}>
              Saving will replace the saved key. The current key remains active until Save.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SaveButton({
  dirty,
  saved,
  loading,
  onClick,
}: {
  dirty: boolean;
  saved: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  if (saved) {
    return (
      <span className="inline-flex items-center gap-1 text-xs" style={{ color: "#2e7d32" }}>
        <Check className="h-3 w-3" /> Saved
      </span>
    );
  }

  if (!dirty) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={loading}
      className="h-7 text-xs"
      style={{ borderColor: "#ddd5c8" }}
    >
      Save
    </Button>
  );
}

// ── Settings Page ──────────────────────────────────────────────────

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  const { data: settingsResponse, isLoading } = useQuery<SettingsResponse>({
    queryKey: ["settings"],
    queryFn: async () => {
      return api.get<SettingsResponse>("/settings");
    },
  });
  const settings = settingsResponse?.settings;
  const savedSecretKeys = new Set(settingsResponse?.savedSecretKeys ?? []);

  const updateSetting = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.put(`/settings/${key}`, { value }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      setDirty((prev) => {
        const next = { ...prev };
        delete next[variables.key];
        return next;
      });
      setSaved((prev) => ({ ...prev, [variables.key]: true }));
      setTimeout(() => {
        setSaved((prev) => {
          const next = { ...prev };
          delete next[variables.key];
          return next;
        });
      }, 2000);
    },
  });

  const val = (key: string): string => {
    if (key in dirty) return dirty[key];
    return settings?.[key] ?? "";
  };

  const setVal = (key: string, value: string) => {
    setDirty((prev) => ({ ...prev, [key]: value }));
  };

  const resetVal = (key: string) => {
    setDirty((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const secretVal = (key: SecretSettingKey): string => {
    if (key in dirty) return dirty[key];
    return "";
  };

  const hasSavedSecret = (key: SecretSettingKey): boolean => savedSecretKeys.has(key);

  const saveKey = (key: string) => {
    if (key in dirty) {
      updateSetting.mutate({ key, value: dirty[key] });
    }
  };

  const hasDirty = Object.keys(dirty).length > 0;

  const handleSaveAll = () => {
    for (const key of Object.keys(dirty)) {
      updateSetting.mutate({ key, value: dirty[key] });
    }
  };

  const currentAdapter = val("ADAPTER_TYPE") || "claude-code";
  const showApiKey = currentAdapter === "anthropic-sdk";

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl">
        <p className="text-sm" style={{ color: "#8a8070" }}>Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5" style={{ color: "#8a8070" }} />
            <h2
              className="text-[22px] font-normal"
              style={{ color: "#1a1f2e", fontFamily: "Georgia, 'Times New Roman', serif" }}
            >
              Settings
            </h2>
          </div>
          <p className="text-[13px] mt-1" style={{ color: "#7a7060" }}>
            Instance configuration
          </p>
        </div>
        {hasDirty && (
          <Button
            size="sm"
            onClick={handleSaveAll}
            disabled={updateSetting.isPending}
            style={{ background: "#1a1f2e", color: "#e8dfd0" }}
          >
            <Save className="h-3.5 w-3.5 mr-1" /> Save Changes
          </Button>
        )}
      </div>

      {/* Adapter Configuration */}
      <SettingSection title="Adapter Configuration" icon={Bot}>
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>
            Subprocess Adapter
          </label>
          <Select
            value={currentAdapter}
            onValueChange={(v) => setVal("ADAPTER_TYPE", v)}
          >
            <SelectTrigger style={{ borderColor: "#ddd5c8" }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ADAPTER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  <div>
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-xs ml-2" style={{ color: "#8a8070" }}>
                      {opt.description}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {showApiKey && (
          <PasswordField
            label="ANTHROPIC_API_KEY"
            value={secretVal("ANTHROPIC_API_KEY")}
            onChange={(v) => setVal("ANTHROPIC_API_KEY", v)}
            placeholder="sk-ant-..."
            hasSavedValue={hasSavedSecret("ANTHROPIC_API_KEY")}
            isDirty={"ANTHROPIC_API_KEY" in dirty}
            onClearSaved={() => setVal("ANTHROPIC_API_KEY", "")}
            onCancelChange={() => resetVal("ANTHROPIC_API_KEY")}
          />
        )}

        <div className="flex justify-end">
          <SaveButton
            dirty={"ADAPTER_TYPE" in dirty || "ANTHROPIC_API_KEY" in dirty}
            saved={!!saved["ADAPTER_TYPE"] || !!saved["ANTHROPIC_API_KEY"]}
            loading={updateSetting.isPending}
            onClick={() => {
              if ("ADAPTER_TYPE" in dirty) saveKey("ADAPTER_TYPE");
              if ("ANTHROPIC_API_KEY" in dirty) saveKey("ANTHROPIC_API_KEY");
            }}
          />
        </div>
      </SettingSection>

      {/* Household */}
      <SettingSection title="Household" icon={Users}>
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>
            Household Name
          </label>
          <Input
            value={val("HOUSEHOLD_NAME")}
            onChange={(e) => setVal("HOUSEHOLD_NAME", e.target.value)}
            placeholder="The Smith Family"
            style={{ borderColor: "#ddd5c8" }}
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "#5a5a5a" }}>
            Timezone
          </label>
          <Select
            value={val("TIMEZONE") || "America/New_York"}
            onValueChange={(v) => setVal("TIMEZONE", v)}
          >
            <SelectTrigger style={{ borderColor: "#ddd5c8" }}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIMEZONES.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex justify-end">
          <SaveButton
            dirty={"HOUSEHOLD_NAME" in dirty || "TIMEZONE" in dirty}
            saved={!!saved["HOUSEHOLD_NAME"] || !!saved["TIMEZONE"]}
            loading={updateSetting.isPending}
            onClick={() => {
              if ("HOUSEHOLD_NAME" in dirty) saveKey("HOUSEHOLD_NAME");
              if ("TIMEZONE" in dirty) saveKey("TIMEZONE");
            }}
          />
        </div>
      </SettingSection>

      {/* Voice & Media — Groq for voice transcription */}
      <SettingSection title="Voice & Media" icon={Mic}>
        <PasswordField
          label="GROQ_API_KEY"
          value={secretVal("GROQ_API_KEY")}
          onChange={(v) => setVal("GROQ_API_KEY", v)}
          placeholder="gsk_..."
          hasSavedValue={hasSavedSecret("GROQ_API_KEY")}
          isDirty={"GROQ_API_KEY" in dirty}
          onClearSaved={() => setVal("GROQ_API_KEY", "")}
          onCancelChange={() => resetVal("GROQ_API_KEY")}
        />
        <p className="text-xs" style={{ color: "#7a7060" }}>
          Used by Groq Whisper to transcribe voice messages and audio
          attachments. Get a key at{" "}
          <a
            href="https://console.groq.com/keys"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#3a4060", textDecoration: "underline" }}
          >
            console.groq.com/keys
          </a>
          . Without it, voice messages fall back to a "please type instead"
          response.
        </p>
        <div className="flex justify-end">
          <SaveButton
            dirty={"GROQ_API_KEY" in dirty}
            saved={!!saved["GROQ_API_KEY"]}
            loading={updateSetting.isPending}
            onClick={() => {
              if ("GROQ_API_KEY" in dirty) saveKey("GROQ_API_KEY");
            }}
          />
        </div>
      </SettingSection>
    </div>
  );
}
