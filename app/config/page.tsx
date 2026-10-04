"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { FileCode2 } from "lucide-react";
import { Card, toast } from "@heroui/react";
import ConfigEditor from "@/app/components/ConfigEditor";
import ConfigFileTree from "@/app/components/ConfigFileTree";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import { useServers } from "@/app/components/ServerProvider";
import { Skeleton } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";
import { setLeaveGuard } from "@/app/lib/leaveGuard";
import { usePageMotion } from "@/app/lib/motion";
import {
  listConfigFiles,
  readConfigFile,
  restartServer,
  writeConfigFile,
  IpcError,
} from "@/app/lib/ipc";

// Contract §3.7: config paths are now relative, forward-slash
// ("server.properties", "config/foo.toml") - display them as-is.

export default function ConfigPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  // What is on disk for the open file. `null` while it loads or when the
  // read failed: the editor and Save stay off until the text shown is
  // really `selected`'s - otherwise Save would write the previous file's
  // text into the new one.
  const [loaded, setLoaded] = useState<{ file: string; content: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  // Only the newest read may land (fast clicking through the list).
  const readId = useRef(0);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { play } = useUISound();
  const { activeId, overview } = useServers();
  // Restarting only means something for a running server.
  const running = overview.find((item) => item.id === activeId)?.phase === "running";

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

  // Leaving the page or switching server with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) {
      setLeaveGuard(null);
      return;
    }
    setLeaveGuard((proceed) => setPendingLeave(() => proceed));
    return () => setLeaveGuard(null);
  }, [dirty]);

  const selectFile = (file: string) => {
    if (file === selected) return;
    play("click_confirm");
    if (dirty) setPendingFile(file);
    else openFile(file);
  };

  const saveFile = async () => {
    if (!selected || !ready || !dirty) return;
    play("click_confirm");
    setSaving(true);
    try {
      await writeConfigFile(selected, content);
      setLoaded({ file: selected, content });
      play("success");
      toast.success(
        running
          ? `Saved ${selected}. Restart the server for it to take effect.`
          : `Saved ${selected}. It applies the next time the server starts.`,
      );
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
      <div className="min-h-[calc(100dvh-var(--navbar-height))] bg-background">
        <main className="mx-auto flex min-h-[calc(100dvh-var(--navbar-height))] max-w-[1600px] flex-col gap-6 px-4 py-10 md:px-6">
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
      className="min-h-[calc(100dvh-var(--navbar-height))]"
      style={{
        background: `radial-gradient(circle at top, var(--page-wash), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-[1600px] flex-col gap-6 px-4 pt-5 pb-6 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Server Config Editor" icon={FileCode2} />

        <motion.section
          className="grid min-h-0 gap-6 lg:h-[calc(100dvh-var(--navbar-height)-8.5rem)] lg:min-h-[420px] lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]"
          variants={containerMotion}
        >
          <motion.div variants={cardMotion} className="flex min-h-0 flex-col">
            <Card className="flex max-h-[360px] min-h-0 flex-1 flex-col gap-4 p-5 lg:max-h-none">
              <ConfigFileTree
                files={files}
                selected={selected}
                dirty={dirty}
                query={query}
                onQueryChange={setQuery}
                onSelect={selectFile}
              />
            </Card>
          </motion.div>

          <motion.div variants={cardMotion} className="flex min-h-0 flex-col">
            <Card className="h-[calc(100dvh-12rem)] min-h-[480px] flex-1 p-5 lg:h-auto lg:min-h-0">
              <ConfigEditor
                selected={selected}
                content={content}
                onContentChange={setContent}
                ready={ready}
                dirty={dirty}
                saving={saving}
                restarting={restarting}
                running={running}
                fileError={fileError}
                onSave={saveFile}
                onRevert={() => {
                  if (loaded) setContent(loaded.content);
                }}
                onRestart={() => {
                  play("click_confirm");
                  setConfirmOpen(true);
                }}
                onRetry={() => selected && openFile(selected)}
              />
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
          isOpen={pendingLeave !== null}
          title={`Discard changes to ${selected ?? "this file"}?`}
          description={`You edited ${selected ?? "this file"} and have not saved. Leaving throws those edits away.`}
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          variant="danger"
          onCancel={() => setPendingLeave(null)}
          onConfirm={() => {
            const proceed = pendingLeave;
            setPendingLeave(null);
            setLeaveGuard(null);
            proceed?.();
          }}
        />

        <ConfirmDialog
          isOpen={confirmOpen}
          title="Restart the server"
          description="Everyone playing is disconnected for a moment while the server restarts with the saved settings."
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
