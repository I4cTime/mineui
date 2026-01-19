"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Loader2, Send, ShieldAlert, Users } from "lucide-react";
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
      className="min-h-screen mc-grid"
      style={{
        background: `radial-gradient(circle at top, var(--mc-accent-soft), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader
          title="RCON Tools"
          icon={ShieldAlert}
          backHref="/players"
          backLabel="Back to players"
          actions={
            <Link
              className="mc-button"
              href="/"
              onClick={() => play("click_confirm")}
              onMouseEnter={() => play("hover")}
            >
              Dashboard
            </Link>
          }
        />

        <motion.section className="mc-panel p-5" variants={cardMotion}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="mc-chip flex items-center gap-2">
              <ShieldAlert size={14} />
              RCON Command Panel
            </span>
            <span className="text-xs" style={{ color: "var(--mc-muted)" }}>
              Commands restricted by <code className="font-mono">MINECRAFT_RCON_ALLOWLIST</code>.
            </span>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {presets.map((preset) => (
              <button
                key={preset}
                className="mc-button text-sm"
                onClick={() => {
                  play("click_confirm");
                  setCommand(preset);
                }}
                onMouseEnter={() => play("hover")}
                type="button"
              >
                {preset}
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <input
              className="mc-input flex-1"
              placeholder="Enter RCON command, e.g. whitelist add player"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="mc-button"
              onClick={sendCommand}
              disabled={sending}
              onMouseEnter={() => play("hover")}
            >
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              {sending ? "Sending..." : "Send"}
            </button>
          </div>

          <motion.div
            className="mt-4 min-h-[120px] rounded-lg border p-4 font-mono text-xs leading-5"
            style={{
              background: "color-mix(in oklab, var(--background) 70%, black)",
              borderColor: commandError ? "var(--mc-accent)" : "var(--mc-panel-border)",
              color: "var(--foreground)",
            }}
            animate={{ borderColor: commandError ? "var(--mc-accent)" : "var(--mc-panel-border)" }}
          >
            {commandError ? (
              <span style={{ color: "var(--mc-accent)" }}>{commandError}</span>
            ) : commandOutput ? (
              <pre className="whitespace-pre-wrap">{commandOutput}</pre>
            ) : (
              <span style={{ color: "var(--mc-muted)" }}>Command output will appear here.</span>
            )}
          </motion.div>
        </motion.section>

        <motion.section className="mc-panel p-5" variants={cardMotion}>
          <div className="flex items-center gap-3 font-pixel text-xs tracking-wide" style={{ color: "var(--mc-accent)" }}>
            <Users size={16} />
            Quick Actions
          </div>
          <div className="mt-4 grid gap-3 text-sm md:grid-cols-2" style={{ color: "var(--mc-muted)" }}>
            <div className="flex flex-col rounded-lg border p-4" style={{ borderColor: "var(--mc-panel-border)" }}>
              <div className="font-semibold" style={{ color: "var(--foreground)" }}>
                Player Management
              </div>
              <p className="mt-1 flex-1 text-xs">Use the Players page for whitelist, op, ban, and kick commands.</p>
              <Link
                href="/players"
                className="mc-button mt-auto w-fit pt-3"
                onClick={() => play("click_confirm")}
                onMouseEnter={() => play("hover")}
              >
                Go to Players
              </Link>
            </div>
            <div className="flex flex-col rounded-lg border p-4" style={{ borderColor: "var(--mc-panel-border)" }}>
              <div className="font-semibold" style={{ color: "var(--foreground)" }}>
                Server Control
              </div>
              <p className="mt-1 flex-1 text-xs">Start, stop, restart, and backup from the Dashboard.</p>
              <Link
                href="/"
                className="mc-button mt-auto w-fit pt-3"
                onClick={() => play("click_confirm")}
                onMouseEnter={() => play("hover")}
              >
                Go to Dashboard
              </Link>
            </div>
          </div>
        </motion.section>
      </motion.main>
    </div>
  );
}
