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
  Key,
  Bot,
  Users,
  HardDrive,
  AlertTriangle,
  Eye,
  EyeOff,
  Save,
  Check,
} from "lucide-react";

// --- Types ---

interface SettingsMap {
  [key: string]: string;
}

// --- Timezone list (common subset) ---

const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Phoenix",
  "America/Indiana/Indianapolis",
  "America/Detroit",
  "America/Kentucky/Louisville",
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

// --- Sub-components ---

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
    <Card className="mb-4">
      <div className="px-4 py-3 border-b flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">{title}</h3>
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={visible ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="pr-9"
          />
          <button
            type="button"
            onClick={() => setVisible(!visible)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {visible ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReadOnlyField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
        {label}
      </label>
      <Input value={value} readOnly disabled className="bg-secondary/50" />
    </div>
  );
}

// --- Page ---

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  const { data: settings, isLoading } = useQuery<SettingsMap>({
    queryKey: ["settings"],
    queryFn: () => api.get("/settings"),
  });

  const updateSetting = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      api.put(`/settings/${key}`, { value }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      // Clear dirty state for this key, show saved indicator
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

  // Get current value: dirty draft or saved setting
  const val = (key: string): string => {
    if (key in dirty) return dirty[key];
    return settings?.[key] ?? "";
  };

  const setVal = (key: string, value: string) => {
    setDirty((prev) => ({ ...prev, [key]: value }));
  };

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

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl">
        <p className="text-sm text-muted-foreground">Loading settings...</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Settings</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Instance configuration
          </p>
        </div>
        {hasDirty && (
          <Button
            size="sm"
            onClick={handleSaveAll}
            disabled={updateSetting.isPending}
          >
            <Save className="h-3.5 w-3.5 mr-1" />
            Save Changes
          </Button>
        )}
      </div>

      {/* API Keys */}
      <SettingSection title="API Keys" icon={Key}>
        <PasswordField
          label="ANTHROPIC_API_KEY"
          value={val("ANTHROPIC_API_KEY")}
          onChange={(v) => setVal("ANTHROPIC_API_KEY", v)}
          placeholder="sk-ant-..."
        />
        <div className="flex justify-end">
          <SaveButton
            dirty={"ANTHROPIC_API_KEY" in dirty}
            saved={!!saved["ANTHROPIC_API_KEY"]}
            loading={updateSetting.isPending}
            onClick={() => saveKey("ANTHROPIC_API_KEY")}
          />
        </div>
      </SettingSection>

      {/* Telegram */}
      <SettingSection title="Telegram" icon={Bot}>
        <PasswordField
          label="BOT_TOKEN"
          value={val("TELEGRAM_BOT_TOKEN")}
          onChange={(v) => setVal("TELEGRAM_BOT_TOKEN", v)}
          placeholder="123456:ABC-DEF..."
        />
        <div className="flex justify-end">
          <SaveButton
            dirty={"TELEGRAM_BOT_TOKEN" in dirty}
            saved={!!saved["TELEGRAM_BOT_TOKEN"]}
            loading={updateSetting.isPending}
            onClick={() => saveKey("TELEGRAM_BOT_TOKEN")}
          />
        </div>
      </SettingSection>

      {/* Family */}
      <SettingSection title="Family" icon={Users}>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Family Name
          </label>
          <Input
            value={val("FAMILY_NAME")}
            onChange={(e) => setVal("FAMILY_NAME", e.target.value)}
            placeholder="The Daws Family"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
            Timezone
          </label>
          <Select
            value={val("TIMEZONE") || "America/New_York"}
            onValueChange={(v) => setVal("TIMEZONE", v)}
          >
            <SelectTrigger>
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
        <div className="flex justify-end gap-2">
          <SaveButton
            dirty={"FAMILY_NAME" in dirty || "TIMEZONE" in dirty}
            saved={!!saved["FAMILY_NAME"] || !!saved["TIMEZONE"]}
            loading={updateSetting.isPending}
            onClick={() => {
              if ("FAMILY_NAME" in dirty) saveKey("FAMILY_NAME");
              if ("TIMEZONE" in dirty) saveKey("TIMEZONE");
            }}
          />
        </div>
      </SettingSection>

      {/* Data */}
      <SettingSection title="Data" icon={HardDrive}>
        <ReadOnlyField
          label="Data Directory"
          value={val("DATA_DIR") || "~/.carson-os"}
        />
        <ReadOnlyField
          label="Database Path"
          value={val("DATABASE_PATH") || "~/.carson-os/carson.db"}
        />
      </SettingSection>

      {/* Danger zone */}
      <Card className="border-red-200">
        <div className="px-4 py-3 border-b border-red-200 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <h3 className="text-sm font-semibold text-red-600">Danger Zone</h3>
        </div>
        <CardContent className="p-4 pt-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Reset Everything</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Delete all data and start from scratch. This cannot be undone.
              </p>
            </div>
            <Button variant="destructive" size="sm" disabled>
              Reset
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// --- Small save button helper ---

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
      <span className="inline-flex items-center gap-1 text-xs text-green-600">
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
    >
      Save
    </Button>
  );
}
