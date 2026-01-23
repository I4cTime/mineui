"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Save, Settings as SettingsIcon } from "lucide-react";
import { Button, Card, Form, Input, Label, Skeleton, TextField } from "@heroui/react";
import PageHeader from "@/app/components/PageHeader";
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

  const saveSettings = async (event?: React.FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
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
      <div className="min-h-screen" style={{ background: "var(--background)" }}>
        <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-2">
              <Skeleton className="h-5 w-40 rounded" />
              <Skeleton className="h-4 w-64 rounded" />
            </Card.Header>
            <Card.Content className="grid gap-4 md:grid-cols-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="space-y-2">
                  <Skeleton className="h-3 w-24 rounded" />
                  <Skeleton className="h-10 w-full rounded-lg" />
                </div>
              ))}
            </Card.Content>
            <Card.Footer className="justify-end">
              <Skeleton className="h-10 w-36 rounded-lg" />
            </Card.Footer>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen"
      style={{
        background: `radial-gradient(circle at top, color-mix(in oklab, var(--accent) 18%, transparent), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Settings" icon={SettingsIcon} />

        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <Card.Title>Connection settings</Card.Title>
              <Card.Description>
                Configure how MineUI connects to your server and tools.
              </Card.Description>
            </Card.Header>
            <Card.Content>
              <Form className="grid gap-4 md:grid-cols-2" onSubmit={saveSettings}>
                {fields.map((field) => (
                  <TextField
                    key={field.key}
                    name={field.key}
                    type={field.type ?? "text"}
                    className="flex flex-col gap-2"
                  >
                    <Label>{field.label}</Label>
                    <Input
                      fullWidth
                      placeholder={field.placeholder}
                      value={values[field.key] ?? ""}
                      onChange={(event) => updateField(field.key, event.target.value)}
                      onFocus={() => play("hover")}
                    />
                  </TextField>
                ))}
                <div className="md:col-span-2 flex items-center justify-end pt-2">
                  <Button
                    type="submit"
                    isDisabled={saving}
                    isPending={saving}
                  >
                    <Save size={16} />
                    {saving ? "Saving..." : "Save settings"}
                  </Button>
                </div>
              </Form>
            </Card.Content>
          </Card>
        </motion.section>
      </motion.main>
    </div>
  );
}
