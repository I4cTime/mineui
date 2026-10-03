"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { FileCode2, Loader2, RefreshCcw, Save, Search } from "lucide-react";
import {
  Button,
  Card,
  Label,
  ListBox,
  TextField,
  Input,
  toast,
} from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import { Skeleton } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";
import { usePageMotion } from "@/app/lib/motion";
import {
  listConfigFiles,
  readConfigFile,
  restartServer,
  writeConfigFile,
  IpcError,
} from "@/app/lib/ipc";

// Contract §3.7: config paths are now relative, forward-slash
// ("server.properties", "config/foo.toml") — display them as-is.

export default function ConfigPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  // What is on disk for the open file. `null` while it loads or when the
  // read failed: the editor and Save stay off until the text shown is
  // really `selected`'s — otherwise Save would write the previous file's
  // text into the new one.
  const [loaded, setLoaded] = useState<{ file: string; content: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  // Only the newest read may land (fast clicking through the list).
  const readId = useRef(0);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { play } = useUISound();

  const openFile = useCallback((file: string) => {
    const myRead = ++readId.current;
    setSelected(file);
    setLoaded(null);
    setContent("");
    setFileError(null);
    readConfigFile(file)
      .then((data) => {
        if (readId.current !== myRead) return;
        setLoaded({ file, content: data.content });
        setContent(data.content);
      })
      .catch((error: unknown) => {
        if (readId.current !== myRead) return;
        setFileError(error instanceof IpcError ? error.message : "Read failed.");
      });
  }, []);

  useEffect(() => {
    listConfigFiles()
      .then((data) => {
        setFiles(data.files);
        if (data.files.length) {
          openFile(data.files[0]);
        }
      })
      .catch((error: unknown) => {
        toast.danger(
          error instanceof IpcError ? error.message : "Failed to load.",
        );
      })
      .finally(() => setLoading(false));
  }, [openFile]);

  const ready = loaded !== null && loaded.file === selected;
  const dirty = ready && content !== loaded.content;

  const filteredFiles = useMemo(() => {
    const needle = query.toLowerCase().trim();
    if (!needle) return files;
    return files.filter((file) => file.toLowerCase().includes(needle));
  }, [files, query]);

  const saveFile = async () => {
    if (!selected || !ready || !dirty) return;
    play("click_confirm");
    setSaving(true);
    try {
      await writeConfigFile(selected, content);
      setLoaded({ file: selected, content });
      play("success");
      toast.success(`Saved ${selected}. Restart the server for it to take effect.`);
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    try {
      await restartServer();
      play("success");
      toast.success("Server restart triggered");
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Restart failed.");
    } finally {
      setRestarting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
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
        background: `radial-gradient(circle at top, var(--page-wash), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-5 pb-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Server Config Editor" icon={FileCode2} />

        <motion.section className="grid gap-6 lg:grid-cols-[320px_1fr]" variants={containerMotion}>
          <motion.div variants={cardMotion}>
            <Card className="flex flex-col gap-4 p-5 h-full">
              <div className="flex items-center gap-2">
                <Search size={16} className="text-muted" />
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
                      if (!next || String(next) === selected) return;
                      play("click_confirm");
                      if (dirty) {
                        setPendingFile(String(next));
                      } else {
                        openFile(String(next));
                      }
                    }}
                  >
                    {filteredFiles.map((file) => (
                      <ListBox.Item key={file} id={file} textValue={file}>
                        {file}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                ) : (
                  <span className="text-muted">
                    {files.length
                      ? `No files match “${query.trim()}”.`
                      : "No config files yet — start the server once to create them."}
                  </span>
                )}
              </div>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="flex flex-col gap-4 p-5">
              <Card.Header className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-pixel text-xs tracking-wide text-accent">
                    {selected ?? "Select a file"}
                  </span>
                  {dirty && <span className="text-xs text-warning">Unsaved changes</span>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onPress={saveFile}
                    isDisabled={saving || !dirty}
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
              <Card.Content className="grid gap-3">
                {fileError && selected && (
                  <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger p-3 text-sm">
                    <span>
                      Could not open {selected}: {fileError}
                    </span>
                    <Button size="sm" variant="secondary" onPress={() => openFile(selected)}>
                      Try again
                    </Button>
                  </div>
                )}
                <textarea
                  aria-label={selected ? `Contents of ${selected}` : "File contents"}
                  className="min-h-[520px] w-full resize-y rounded-lg border border-field-border bg-field p-3 font-mono text-xs text-foreground disabled:opacity-60"
                  value={content}
                  disabled={!ready}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder={
                    !selected
                      ? "Select a file to load its contents."
                      : fileError
                        ? ""
                        : ready
                          ? "This file is empty."
                          : `Opening ${selected}…`
                  }
                />
              </Card.Content>
            </Card>
          </motion.div>
        </motion.section>

        <ConfirmDialog
          isOpen={pendingFile !== null}
          title={`Discard changes to ${selected ?? "this file"}?`}
          description={`You edited ${selected ?? "this file"} and have not saved. Opening ${pendingFile ?? "another file"} throws those edits away.`}
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          variant="danger"
          onCancel={() => setPendingFile(null)}
          onConfirm={() => {
            const next = pendingFile;
            setPendingFile(null);
            if (next) openFile(next);
          }}
        />

        <ConfirmDialog
          isOpen={confirmOpen}
          title="Restart Minecraft server?"
          description="This will disconnect players and restart the server."
          confirmLabel="Restart"
          cancelLabel="Cancel"
          variant="danger"
          isLoading={restarting}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async () => {
            setConfirmOpen(false);
            await handleRestart();
          }}
        />
      </motion.main>
    </div>
  );
}
