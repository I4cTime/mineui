"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Loader2, Send, ShieldAlert, Users } from "lucide-react";
import { Button, Card, Chip, TextField, Input } from "@heroui/react";
import PageHeader from "@/app/components/PageHeader";
import { useUISound } from "@/app/hooks/useUISound";

const containerMotion = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const cardMotion = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 },
};

const presets = [
  "list",
  "whitelist list",
  "ops",
  "banlist",
  "save-all",
  "say Server save completed.",
];

export default function RconPage() {
  const router = useRouter();
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
      const res = await fetch("/api/rcon/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        play("error");
        setCommandError(payload.error ?? "Command failed.");
        toast.error(payload.error ?? "Command failed.");
      } else {
        play("success");
        setCommandOutput(payload.output ?? "OK");
        toast.success("Command executed");
      }
    } catch (error) {
      play("error");
      const message = error instanceof Error ? error.message : "Command failed.";
      setCommandError(message);
      toast.error(message);
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
              <span className="text-xs text-[var(--muted)]">
                Commands restricted by{" "}
                <code className="font-mono">MINECRAFT_RCON_ALLOWLIST</code>.
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
                className="mt-4 min-h-[120px] rounded-lg border p-4 font-mono text-xs leading-5"
                style={{
                  background: "color-mix(in oklab, var(--background) 70%, black)",
                  borderColor: commandError ? "var(--accent)" : "var(--border)",
                  color: "var(--foreground)",
                }}
                animate={{ borderColor: commandError ? "var(--accent)" : "var(--border)" }}
              >
                {commandError ? (
                  <span style={{ color: "var(--accent)" }}>{commandError}</span>
                ) : commandOutput ? (
                  <pre className="whitespace-pre-wrap">{commandOutput}</pre>
                ) : (
                  <span style={{ color: "var(--muted)" }}>
                    Command output will appear here.
                  </span>
                )}
              </motion.div>
            </Card.Content>
          </Card>
        </motion.section>
      </motion.main>
    </div>
  );
}
