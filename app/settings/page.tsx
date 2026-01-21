"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Save, Settings as SettingsIcon } from "lucide-react";
import PageHeader from "@/app/components/PageHeader";
import { SkeletonCard } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";

type SettingsPayload = Record<string, string>;

const fields: Array<{
  key: string;
  label: string;
  placeholder: string;
  type?: string;
}> = [
  { key: "MINECRAFT_CONTAINER_NAME", label: "Container name", placeholder: "minecraft-server" },
  { key: "MINECRAFT_QUERY_HOST", label: "Query host", placeholder: "127.0.0.1" },
  { key: "MINECRAFT_QUERY_PORT", label: "Query port", placeholder: "25565", type: "number" },
  { key: "PODMAN_SOCKET", label: "Podman socket", placeholder: "/run/user/1000/podman/podman.sock" },
  { key: "PODMAN_BINARY", label: "Podman binary", placeholder: "podman" },
  { key: "MINECRAFT_WORLD_DIR", label: "World directory", placeholder: "world" },
  { key: "MINECRAFT_RCON_HOST", label: "RCON host", placeholder: "127.0.0.1" },
  { key: "MINECRAFT_RCON_PORT", label: "RCON port", placeholder: "25575", type: "number" },
  { key: "MINECRAFT_RCON_PASSWORD", label: "RCON password", placeholder: "change-me", type: "password" },
  { key: "MINECRAFT_RCON_ALLOWLIST", label: "RCON allowlist", placeholder: "list,whitelist,op,deop,ban,pardon" },
  { key: "MINEUI_SERVER_UTILS_URL", label: "Utilities URL", placeholder: "http://127.0.0.1:8787" },
];

const fetchJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
};

const containerMotion = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const cardMotion = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 },
};

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<SettingsPayload>({});
  const { play } = useUISound();

  useEffect(() => {
    fetchJson<{ ok: boolean; settings: SettingsPayload }>("/api/settings")
      .then((data) => setValues(data.settings ?? {}))
      .catch(() => setValues({}))
      .finally(() => setLoading(false));
  }, []);

  const updateField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const saveSettings = async () => {
    setSaving(true);
    play("click_confirm");
    try {
      const res = await fetchJson<{ ok: boolean; error?: string }>(
        "/api/settings",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        },
      );
      if (!res.ok) throw new Error(res.error ?? "Save failed");
      play("success");
      toast.success("Settings saved");
    } catch (error) {
      play("error");
      toast.error(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen mc-grid" style={{ background: "var(--background)" }}>
        <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <SkeletonCard />
        </main>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen mc-grid"
      style={{
        background: `radial-gradient(circle at top, var(--mc-accent-soft), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Settings" icon={SettingsIcon} />

        <motion.section className="mc-panel p-6" variants={cardMotion}>
          <div className="grid gap-4 md:grid-cols-2">
            {fields.map((field) => (
              <label key={field.key} className="flex flex-col gap-2 text-sm">
                <span className="text-xs" style={{ color: "var(--mc-muted)" }}>
                  {field.label}
                </span>
                <input
                  className="mc-input"
                  type={field.type ?? "text"}
                  placeholder={field.placeholder}
                  value={values[field.key] ?? ""}
                  onChange={(event) => updateField(field.key, event.target.value)}
                />
              </label>
            ))}
          </div>
          <div className="mt-6 flex items-center justify-end">
            <button
              className="mc-button"
              onClick={saveSettings}
              disabled={saving}
              onMouseEnter={() => play("hover")}
            >
              <Save size={16} className={saving ? "animate-spin" : ""} />
              {saving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </motion.section>
      </motion.main>
    </div>
  );
}
