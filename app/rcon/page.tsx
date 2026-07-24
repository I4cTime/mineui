"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, Send, ShieldAlert } from "lucide-react";
import { Button, Card, Chip, ScrollShadow, TextField, Input, toast } from "@heroui/react";
import PageHeader from "@/app/components/PageHeader";
import { useUISound } from "@/app/hooks/useUISound";
import { listStagger, scaleIn, transition } from "@/app/lib/motion";
import { runRconCommand, IpcError } from "@/app/lib/ipc";

const presets = [
  "list",
  "whitelist list",
  "ops",
  "banlist",
  "save-all",
  "say Server save completed.",
];

export default function RconPage() {
  // Re-read on every render so a theme switch is picked up (docs/theme-contract.md §6).
  const containerMotion = listStagger();
  const cardMotion = scaleIn();
  const [command, setCommand] = useState("");
  const [commandOutput, setCommandOutput] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { play } = useUISound();

  const sendCommand = async () => {
    if (!command.trim()) return;
    play("click_confirm");
    setSending(true);
    setCommandError(null);
    setCommandOutput(null);
    try {
      const { output } = await runRconCommand(command);
      play("success");
      setCommandOutput(output || "OK");
      toast.success("Command executed");
    } catch (error) {
      play("error");
      const message =
        error instanceof IpcError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Command failed.";
      setCommandError(message);
      toast.danger(message);
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendCommand();
    }
  };

  return (
    <div
      className="min-h-screen"
      style={{
        background: `radial-gradient(circle at top, color-mix(in oklab, var(--accent) 18%, transparent), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-4xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader
          title="RCON Tools"
          icon={ShieldAlert}
          actions={null}
        />

        <motion.section variants={cardMotion}>
          <Card className="p-5">
            <Card.Header className="flex flex-wrap items-center gap-3 text-sm">
              <Chip variant="soft" color="accent" className="flex items-center gap-2">
                <ShieldAlert size={14} />
                RCON Command Panel
              </Chip>
              <span className="text-xs text-muted">
                Commands restricted by the RCON allowlist in{" "}
                <span className="font-mono">Settings</span>.
              </span>
            </Card.Header>

            <Card.Content>
              <div className="mt-4 flex flex-wrap gap-2">
                {presets.map((preset) => (
                  <Button
                    key={preset}
                    size="sm"
                    variant="ghost"
                    onPress={() => {
                      play("click_confirm");
                      setCommand(preset);
                    }}
                    onMouseEnter={() => play("hover")}
                    type="button"
                  >
                    {preset}
                  </Button>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <TextField className="flex-1">
                  <Input
                    placeholder="Enter RCON command, e.g. whitelist add player"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    onKeyDown={handleKeyDown}
                  />
                </TextField>
                <Button
                  onPress={sendCommand}
                  isDisabled={sending}
                  onMouseEnter={() => play("hover")}
                >
                  {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  {sending ? "Sending..." : "Send"}
                </Button>
              </div>

              <motion.div
                className="mt-4 overflow-hidden rounded-lg border"
                style={{
                  borderColor: commandError ? "var(--accent)" : "var(--border)",
                }}
                animate={{ borderColor: commandError ? "var(--accent)" : "var(--border)" }}
                transition={transition("fast")}
              >
                <ScrollShadow
                  className="min-h-30 max-h-80 p-4 font-mono text-xs leading-5 text-foreground"
                  style={{
                    background: "color-mix(in oklab, var(--background) 70%, black)",
                  }}
                >
                  {commandError ? (
                    <span className="text-accent">{commandError}</span>
                  ) : commandOutput ? (
                    <pre className="whitespace-pre-wrap">{commandOutput}</pre>
                  ) : (
                    <span className="text-muted">
                      Command output will appear here.
                    </span>
                  )}
                </ScrollShadow>
              </motion.div>
            </Card.Content>
          </Card>
        </motion.section>
      </motion.main>
    </div>
  );
}
