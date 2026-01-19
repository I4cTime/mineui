"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Send, ShieldAlert } from "lucide-react";

export default function RconPage() {
  const [command, setCommand] = useState("");
  const [commandOutput, setCommandOutput] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const sendCommand = async () => {
    if (!command.trim()) return;
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
        setCommandError(payload.error ?? "Command failed.");
      } else {
        setCommandOutput(payload.output ?? "OK");
      }
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "Command failed.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(29,68,38,0.55),_transparent_60%)] mc-grid">
      <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ShieldAlert size={20} className="text-emerald-200" />
            <h1 className="mc-title mc-glow">RCON Tools</h1>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link className="mc-button" href="/players">
              Back to players
            </Link>
            <Link className="mc-button" href="/">
              <ArrowLeft size={16} />
              Dashboard
            </Link>
          </div>
        </header>

        <section className="mc-panel p-5">
          <div className="flex flex-wrap items-center gap-3 text-sm text-emerald-200/80">
            <span className="mc-chip flex items-center gap-2">
              <ShieldAlert size={14} />
              RCON Command Panel
            </span>
            <span className="text-xs text-emerald-200/70">
              Commands are restricted by `MINECRAFT_RCON_ALLOWLIST`.
            </span>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              "list",
              "whitelist list",
              "ops",
              "banlist",
              "save-all",
              "say Server save completed.",
            ].map((preset) => (
              <button
                key={preset}
                className="mc-button"
                onClick={() => setCommand(preset)}
                type="button"
              >
                {preset}
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <input
              className="w-full rounded-lg border border-emerald-900/60 bg-black/60 px-3 py-2 text-sm text-emerald-100 outline-none md:flex-1"
              placeholder="Enter RCON command, e.g. whitelist add player"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            <button
              className="mc-button"
              onClick={sendCommand}
              disabled={sending}
            >
              <Send size={16} />
              {sending ? "Sending..." : "Send"}
            </button>
          </div>
          <div className="mt-4 rounded-lg border border-emerald-900/60 bg-black/70 p-4 text-xs leading-5 text-emerald-100/90">
            {commandError ? (
              <span className="text-amber-200">{commandError}</span>
            ) : commandOutput ? (
              <pre className="whitespace-pre-wrap">{commandOutput}</pre>
            ) : (
              <span className="text-emerald-200/70">
                Command output will appear here.
              </span>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
