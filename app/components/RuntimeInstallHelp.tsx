"use client";

// How to install Podman or Docker — shown wherever advanced mode needs a
// container runtime and `detect_runtimes` found neither. Opens on the
// visitor's own OS; the other two are a tab away. Commands are copyable;
// nothing here runs anything.
import { useState } from "react";
import { Check, Copy, ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";
import { Button, Tabs } from "@heroui/react";
import OutLink from "@/app/components/OutLink";
import { useUISound } from "@/app/hooks/useUISound";

type Os = "linux" | "windows" | "mac";

type Step = { label?: string; command: string };

type Option = {
  name: string;
  /** Why you would pick this one. */
  note: string;
  steps: Step[];
  after?: string;
  link: { href: string; label: string };
};

const GUIDE: Record<Os, { label: string; options: Option[] }> = {
  linux: {
    label: "Linux",
    options: [
      {
        name: "Podman",
        note: "Recommended. No background service, and it runs as your own user.",
        steps: [
          { label: "Debian / Ubuntu", command: "sudo apt install podman" },
          { label: "Fedora", command: "sudo dnf install podman" },
          { label: "Arch", command: "sudo pacman -S podman" },
          { label: "openSUSE", command: "sudo zypper install podman" },
        ],
        link: { href: "https://podman.io/docs/installation", label: "Podman install guide" },
      },
      {
        name: "Docker",
        note: "If you already use Docker elsewhere.",
        steps: [
          {
            label: "After installing Docker Engine for your distribution",
            command: "sudo usermod -aG docker $USER",
          },
        ],
        after:
          "Then log out and back in. MineUI runs docker as you, without sudo, so your user must be in the docker group.",
        link: { href: "https://docs.docker.com/engine/install/", label: "Docker Engine install guide" },
      },
    ],
  },
  windows: {
    label: "Windows",
    options: [
      {
        name: "Podman",
        note: "Recommended. Free for any use.",
        steps: [
          { label: "Needs WSL 2 (once, then restart)", command: "wsl --install" },
          { command: "winget install RedHat.Podman" },
          { command: "podman machine init" },
          { command: "podman machine start" },
        ],
        after: "Prefer a window? Podman Desktop does the last two steps for you.",
        link: { href: "https://podman-desktop.io", label: "Podman Desktop" },
      },
      {
        name: "Docker Desktop",
        note: "If you already use Docker elsewhere.",
        steps: [{ command: "winget install Docker.DockerDesktop" }],
        after: "Start Docker Desktop once and leave it running.",
        link: { href: "https://docs.docker.com/desktop/setup/install/windows-install/", label: "Docker Desktop for Windows" },
      },
    ],
  },
  mac: {
    label: "macOS",
    options: [
      {
        name: "Podman",
        note: "Recommended. Free for any use.",
        steps: [
          { command: "brew install podman" },
          { command: "podman machine init" },
          { command: "podman machine start" },
        ],
        after: "Prefer a window? Podman Desktop does the last two steps for you.",
        link: { href: "https://podman-desktop.io", label: "Podman Desktop" },
      },
      {
        name: "Docker Desktop",
        note: "If you already use Docker elsewhere.",
        steps: [{ command: "brew install --cask docker-desktop" }],
        after: "Start Docker Desktop once and leave it running.",
        link: { href: "https://docs.docker.com/desktop/setup/install/mac-install/", label: "Docker Desktop for Mac" },
      },
    ],
  },
};

const detectOs = (): Os => {
  if (typeof navigator === "undefined") return "linux";
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  return "linux";
};

function CommandRow({ step }: { step: Step }) {
  const { play } = useUISound();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(step.command);
      play("success");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      play("error");
    }
  };
  return (
    <div className="grid gap-1">
      {step.label && <span className="text-xs text-muted">{step.label}</span>}
      <div
        className="flex items-center justify-between gap-2 rounded-lg border border-border py-1 pr-1 pl-3"
        style={{ background: "var(--well)" }}
      >
        <code className="min-w-0 truncate font-mono text-xs">{step.command}</code>
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          aria-label={`Copy: ${step.command}`}
          onPress={copy}
          onMouseEnter={() => play("hover")}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </Button>
      </div>
    </div>
  );
}

interface RuntimeInstallHelpProps {
  /** Re-run the runtime probe. */
  onRecheck: () => void;
  checking?: boolean;
}

export default function RuntimeInstallHelp({ onRecheck, checking = false }: RuntimeInstallHelpProps) {
  const { play } = useUISound();
  const [os, setOs] = useState<Os>(detectOs);

  return (
    <div
      className="grid gap-4 rounded-lg border border-warning p-4 text-sm"
      role="region"
      aria-label="Install a container runtime"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert size={18} className="mt-0.5 shrink-0 text-warning" />
        <div className="grid gap-1">
          <span className="font-semibold">Podman or Docker is needed, and neither was found</span>
          <span className="text-xs text-muted">
            A container server runs inside one of them. Install either — MineUI
            finds it by itself and uses Podman when both are there. Nothing
            below is run for you; copy the commands into a terminal.
          </span>
        </div>
      </div>

      <Tabs selectedKey={os} onSelectionChange={(key) => setOs(key as Os)}>
        <Tabs.ListContainer>
          <Tabs.List aria-label="Operating system">
            {(Object.keys(GUIDE) as Os[]).map((id) => (
              <Tabs.Tab key={id} id={id}>
                {GUIDE[id].label}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
        {(Object.keys(GUIDE) as Os[]).map((id) => (
          <Tabs.Panel key={id} id={id} className="grid gap-4 pt-4 md:grid-cols-2">
            {GUIDE[id].options.map((option) => (
              <div key={option.name} className="grid content-start gap-3">
                <div className="grid gap-0.5">
                  <span className="text-sm font-semibold">{option.name}</span>
                  <span className="text-xs text-muted">{option.note}</span>
                </div>
                {option.steps.map((step) => (
                  <CommandRow key={step.command} step={step} />
                ))}
                {option.after && <span className="text-xs text-muted">{option.after}</span>}
                <OutLink href={option.link.href} className="inline-flex items-center gap-1.5 text-xs text-accent underline">
                  {option.link.label}
                  <ExternalLink size={12} />
                </OutLink>
              </div>
            ))}
          </Tabs.Panel>
        ))}
      </Tabs>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <span className="max-w-xl text-xs text-muted">
          Installed it but MineUI still cannot see it? An app started from a
          launcher can have a shorter PATH than your terminal. Put the full
          path to <code className="font-mono">podman</code> or{" "}
          <code className="font-mono">docker</code> in this server&apos;s Settings →
          Advanced → Runtime binary override, save, then check again.
        </span>
        <Button
          variant="secondary"
          isDisabled={checking}
          onPress={() => {
            play("click_confirm");
            onRecheck();
          }}
          onMouseEnter={() => play("hover")}
        >
          <RefreshCw size={14} className={checking ? "animate-spin" : undefined} />
          Check again
        </Button>
      </div>
    </div>
  );
}
