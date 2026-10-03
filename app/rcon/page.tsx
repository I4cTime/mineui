"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Loader2, Send, Terminal, Trash2 } from "lucide-react";
import { Button, Card, Chip, Input, Label, TextField } from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import ServerStateNotice from "@/app/components/ServerStateNotice";
import { useServers } from "@/app/components/ServerProvider";
import { useUISound } from "@/app/hooks/useUISound";
import { usePageMotion } from "@/app/lib/motion";
import { getSettings, runRconCommand, IpcError } from "@/app/lib/ipc";

type Line = { id: number; kind: "command" | "reply" | "error"; text: string };

// Friendly presets. Each is only offered when its command is in the allowlist.
const PRESETS: { label: string; command: string; needsArgument?: boolean }[] = [
  { label: "Who's online", command: "list" },
  { label: "Save the world now", command: "save-all" },
  { label: "Show the whitelist", command: "whitelist list" },
  { label: "Show bans", command: "banlist" },
  { label: "Say something…", command: "say ", needsArgument: true },
];

const firstWord = (value: string) => value.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

export default function ConsolePage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const { activeId } = useServers();
  const { play } = useUISound();
  const [command, setCommand] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [sending, setSending] = useState(false);
  const [allowlist, setAllowlist] = useState<string[] | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const history = useRef<string[]>([]);
  const historyPos = useRef<number | null>(null);
  const draft = useRef("");
  const nextId = useRef(1);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((settings) => {
        if (!cancelled) setAllowlist(settings.rconAllowlist);
      })
      .catch(() => {
        if (!cancelled) setAllowlist([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const presets = useMemo(() => {
    if (!allowlist) return [];
    return PRESETS.filter((preset) => allowlist.includes(firstWord(preset.command)));
  }, [allowlist]);

  const append = useCallback((entries: Omit<Line, "id">[]) => {
    setLines((prev) => [...prev, ...entries.map((entry) => ({ ...entry, id: nextId.current++ }))]);
  }, []);

  const execute = useCallback(
    async (raw: string) => {
      const text = raw.trim().replace(/^\//, "");
      if (!text) return;
      play("click_confirm");
      history.current.push(text);
      historyPos.current = null;
      setCommand("");
      setSending(true);
      const entries: Omit<Line, "id">[] = [{ kind: "command", text: `> ${text}` }];
      try {
        const { output } = await runRconCommand(text);
        play("success");
        entries.push({ kind: "reply", text: output.trim() || "(no reply — the command ran)" });
      } catch (error) {
        play("error");
        let message = "Command failed.";
        if (error instanceof IpcError) {
          message =
            error.code === "RCON_UNAVAILABLE"
              ? "The server isn't reachable — is it running?"
              : error.message;
        } else if (error instanceof Error) {
          message = error.message;
        }
        entries.push({ kind: "error", text: message });
      } finally {
        append(entries);
        setSending(false);
      }
    },
    [append, play],
  );

  const request = (raw: string) => {
    if (firstWord(raw) === "stop") {
      setConfirmStop(true);
      return;
    }
    void execute(raw);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (command.trim() && !sending) request(command);
    } else if (event.key === "ArrowUp") {
      const past = history.current;
      if (!past.length) return;
      event.preventDefault();
      if (historyPos.current === null) {
        draft.current = command;
        historyPos.current = past.length - 1;
      } else {
        historyPos.current = Math.max(0, historyPos.current - 1);
      }
      setCommand(past[historyPos.current]);
    } else if (event.key === "ArrowDown") {
      if (historyPos.current === null) return;
      event.preventDefault();
      const past = history.current;
      if (historyPos.current >= past.length - 1) {
        historyPos.current = null;
        setCommand(draft.current);
      } else {
        historyPos.current += 1;
        setCommand(past[historyPos.current]);
      }
    }
  };

  const runPreset = (preset: (typeof PRESETS)[number]) => {
    play("click_confirm");
    if (preset.needsArgument) {
      setCommand(preset.command);
      inputRef.current?.focus();
    } else {
      request(preset.command);
    }
  };

  return (
    <div
      className="min-h-screen"
      style={{
        background: `radial-gradient(circle at top, var(--page-wash), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-4xl flex-col gap-6 px-4 pt-5 pb-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Server Console" icon={Terminal} actions={null} />

        <ServerStateNotice need="running" what="to send commands" />

        <motion.section variants={cardMotion}>
          <Card className="p-5">
            <Card.Header className="flex flex-col items-start gap-2">
              <p className="text-sm">
                Send a command to the running server — the same as typing it in the server&apos;s
                own console. No leading slash.
              </p>
              {allowlist && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <span>Allowed here:</span>
                  {allowlist.length ? (
                    allowlist.map((name) => (
                      <Chip key={name} size="sm" variant="soft">
                        <span className="font-mono">{name}</span>
                      </Chip>
                    ))
                  ) : (
                    <span>nothing yet</span>
                  )}
                  <span>
                    — change in{" "}
                    <Link href="/settings" className="text-accent underline underline-offset-2">
                      Server Settings
                    </Link>
                  </span>
                </div>
              )}
            </Card.Header>

            <Card.Content>
              {presets.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {presets.map((preset) => (
                    <Button
                      key={preset.label}
                      size="sm"
                      variant="secondary"
                      isDisabled={sending}
                      onPress={() => runPreset(preset)}
                      onMouseEnter={() => play("hover")}
                      type="button"
                    >
                      {preset.label}
                    </Button>
                  ))}
                </div>
              )}

              <div
                ref={outputRef}
                role="log"
                aria-label="Console transcript"
                className="mt-4 max-h-80 min-h-40 overflow-y-auto rounded-lg border border-border p-4 font-mono text-xs leading-5 text-foreground"
                style={{ background: "var(--well)" }}
              >
                {lines.length === 0 ? (
                  <span className="text-muted">
                    Commands and the server&apos;s replies will appear here.
                  </span>
                ) : (
                  lines.map((line) => (
                    <pre
                      key={line.id}
                      className={
                        line.kind === "error"
                          ? "whitespace-pre-wrap text-danger"
                          : line.kind === "command"
                            ? "mt-2 whitespace-pre-wrap text-accent first:mt-0"
                            : "whitespace-pre-wrap"
                      }
                    >
                      {line.text}
                    </pre>
                  ))
                )}
              </div>

              <div className="mt-4 flex flex-wrap items-end gap-3">
                <TextField className="min-w-60 flex-1" aria-label="Command">
                  <Label className="sr-only">Command</Label>
                  <Input
                    ref={inputRef}
                    placeholder="e.g. whitelist add Steve  (Up arrow: previous command)"
                    value={command}
                    onChange={(event) => {
                      setCommand(event.target.value);
                      historyPos.current = null;
                    }}
                    onKeyDown={handleKeyDown}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </TextField>
                <Button
                  onPress={() => request(command)}
                  isDisabled={sending || !command.trim()}
                  onMouseEnter={() => play("hover")}
                >
                  {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  {sending ? "Sending..." : "Send"}
                </Button>
                <Button
                  variant="tertiary"
                  isDisabled={lines.length === 0}
                  onPress={() => {
                    play("click_back");
                    setLines([]);
                  }}
                >
                  <Trash2 size={16} />
                  Clear
                </Button>
              </div>
            </Card.Content>
          </Card>
        </motion.section>

        <ConfirmDialog
          isOpen={confirmStop}
          title="Stop the server"
          description="Stop the server? Everyone playing is disconnected."
          confirmLabel="Stop server"
          variant="danger"
          onCancel={() => setConfirmStop(false)}
          onConfirm={() => {
            setConfirmStop(false);
            void execute(command.trim() && firstWord(command) === "stop" ? command : "stop");
          }}
        />
      </motion.main>
    </div>
  );
}
