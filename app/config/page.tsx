"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { FileCode2, Loader2, RefreshCcw, Save, Search } from "lucide-react";
import {
  Button,
  Card,
  Label,
  ListBox,
  TextField,
  Input,
} from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import { Skeleton } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";

type ConfigListResponse = {
  ok: boolean;
  files: string[];
  error?: string;
};

type ReadResponse = {
  ok: boolean;
  content: string;
  error?: string;
};

const fetchJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
};

const labelFor = (path: string) =>
  path === "/data/server.properties" ? "server.properties" : path.replace("/data/config/", "config/");

const containerMotion = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const cardMotion = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 },
};

export default function ConfigPage() {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { play } = useUISound();

  useEffect(() => {
    fetchJson<ConfigListResponse>("/api/config/list")
      .then((data) => {
        setFiles(data.files ?? []);
        if (data.files?.length) {
          setSelected(data.files[0]);
        }
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : "Failed to load.");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected) return;
    fetchJson<ReadResponse>("/api/config/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: selected }),
    })
      .then((data) => setContent(data.content ?? ""))
      .catch((error) => toast.error(error instanceof Error ? error.message : "Read failed."));
  }, [selected]);

  const filteredFiles = useMemo(() => {
    const needle = query.toLowerCase().trim();
    if (!needle) return files;
    return files.filter((file) => file.toLowerCase().includes(needle));
  }, [files, query]);

  const saveFile = async () => {
    if (!selected) return;
    play("click_confirm");
    setSaving(true);
    try {
      const res = await fetchJson<{ ok: boolean; error?: string }>("/api/config/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selected, content }),
      });
      if (!res.ok) throw new Error(res.error ?? "Save failed.");
      play("success");
      toast.success("Saved successfully");
    } catch (error) {
      play("error");
      toast.error(error instanceof Error ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const restartServer = async () => {
    setRestarting(true);
    try {
      const res = await fetchJson<{ ok: boolean; error?: string }>("/api/server/restart", {
        method: "POST",
      });
      if (!res.ok) throw new Error(res.error ?? "Restart failed.");
      play("success");
      toast.success("Server restart triggered");
    } catch (error) {
      play("error");
      toast.error(error instanceof Error ? error.message : "Restart failed.");
    } finally {
      setRestarting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: "var(--background)" }}>
        <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
            <Skeleton height={400} className="rounded-xl" />
            <Skeleton height={400} className="rounded-xl" />
          </div>
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
        className="page-main mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Server Config Editor" icon={FileCode2} />

        <motion.section className="grid gap-6 lg:grid-cols-[320px_1fr]" variants={containerMotion}>
          <motion.div variants={cardMotion}>
            <Card className="flex flex-col gap-4 p-5 h-full">
              <div className="flex items-center gap-2">
                <Search size={16} className="text-[var(--muted)]" />
                <TextField className="w-full">
                  <Label className="sr-only">Search files</Label>
                  <Input
                    placeholder="Search files"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </TextField>
              </div>
              <div className="max-h-[520px] overflow-auto text-sm">
                {filteredFiles.length ? (
                  <ListBox
                    aria-label="Config files"
                    selectionMode="single"
                    selectedKeys={selected ? new Set([selected]) : new Set()}
                    onSelectionChange={(keys) => {
                      const next = Array.from(keys as Set<string>)[0];
                      if (!next) return;
                      play("click_confirm");
                      setSelected(String(next));
                    }}
                  >
                    {filteredFiles.map((file) => (
                      <ListBox.Item key={file} id={file} textValue={labelFor(file)}>
                        {labelFor(file)}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                ) : (
                  <span className="text-[var(--muted)]">No files found.</span>
                )}
              </div>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="flex flex-col gap-4 p-5">
              <Card.Header className="flex flex-wrap items-center justify-between gap-3">
                <div className="font-pixel text-xs tracking-wide text-[var(--accent)]">
                  {selected ? labelFor(selected) : "Select a file"}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onPress={saveFile}
                    isDisabled={saving}
                    onMouseEnter={() => play("hover")}
                  >
                    {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                    {saving ? "Saving..." : "Save"}
                  </Button>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      play("click_confirm");
                      setConfirmOpen(true);
                    }}
                    isDisabled={restarting}
                    onMouseEnter={() => play("hover")}
                  >
                    <RefreshCcw size={16} />
                    Restart server
                  </Button>
                </div>
              </Card.Header>
              <Card.Content>
                <textarea
                  className="min-h-[520px] w-full resize-y rounded-lg border bg-[var(--field-background)] p-3 font-mono text-xs text-[var(--foreground)]"
                  style={{ borderColor: "var(--field-border)" }}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="Select a file to load its contents."
                />
              </Card.Content>
            </Card>
          </motion.div>
        </motion.section>

        <ConfirmDialog
          isOpen={confirmOpen}
          title="Restart Minecraft server?"
          description="This will disconnect players and restart the container."
          confirmLabel="Restart"
          cancelLabel="Cancel"
          variant="danger"
          isLoading={restarting}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async () => {
            setConfirmOpen(false);
            await restartServer();
          }}
        />
      </motion.main>
    </div>
  );
}
