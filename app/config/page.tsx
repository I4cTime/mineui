"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { FileCode2, Loader2, RefreshCcw, Save, Search } from "lucide-react";
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
      <div className="min-h-screen mc-grid" style={{ background: "var(--background)" }}>
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
      className="min-h-screen mc-grid"
      style={{
        background: `radial-gradient(circle at top, var(--mc-accent-soft), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Server Config Editor" icon={FileCode2} />

        <motion.section className="grid gap-6 lg:grid-cols-[320px_1fr]" variants={containerMotion}>
          <motion.div className="mc-panel flex flex-col gap-4 p-5" variants={cardMotion}>
            <div className="mc-input flex items-center gap-2 pr-2">
              <Search size={16} style={{ color: "var(--mc-muted)" }} />
              <input
                className="w-full bg-transparent outline-none"
                placeholder="Search files"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                style={{ color: "var(--foreground)" }}
              />
            </div>
            <div className="max-h-[520px] overflow-auto text-sm">
              {filteredFiles.length ? (
                filteredFiles.map((file) => (
                  <button
                    key={file}
                    className="block w-full rounded-lg px-3 py-2 text-left transition"
                    style={{
                      background: file === selected ? "var(--mc-accent-soft)" : "transparent",
                      color: file === selected ? "var(--mc-accent)" : "var(--mc-muted)",
                    }}
                    onClick={() => {
                      play("click_confirm");
                      setSelected(file);
                    }}
                    onMouseEnter={() => play("hover")}
                  >
                    {labelFor(file)}
                  </button>
                ))
              ) : (
                <span style={{ color: "var(--mc-muted)" }}>No files found.</span>
              )}
            </div>
          </motion.div>

          <motion.div className="mc-panel flex flex-col gap-4 p-5" variants={cardMotion}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="font-pixel text-xs tracking-wide" style={{ color: "var(--mc-accent)" }}>
                {selected ? labelFor(selected) : "Select a file"}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  className="mc-button"
                  onClick={saveFile}
                  disabled={saving}
                  onMouseEnter={() => play("hover")}
                >
                  {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  {saving ? "Saving..." : "Save"}
                </button>
                <button
                  className="mc-button"
                  onClick={() => {
                    play("click_confirm");
                    setConfirmOpen(true);
                  }}
                  disabled={restarting}
                  onMouseEnter={() => play("hover")}
                >
                  <RefreshCcw size={16} />
                  Restart server
                </button>
              </div>
            </div>
            <textarea
              className="mc-input min-h-[520px] w-full resize-y font-mono text-xs"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Select a file to load its contents."
            />
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
