"use client";

// What to do when a container server cannot start because crun cannot apply
// its process limit (contract §1 PIDS_CONTROLLER_UNAVAILABLE, §3.2). Core has
// already tried lifting the limit in place; this dialog says what is left:
// the per-container command when the lift failed, and on Linux the host fix
// (give user containers the pids cgroup controller). Commands are copyable;
// nothing here runs anything.
//
// Mounted once in the layout. Any Start/Restart call site reports its error
// through `reportLifecycleError`, which opens this dialog for that code and
// shows a toast for everything else.
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { AlertDialog, Button, toast } from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";
import { IpcError } from "@/app/lib/ipc";

type Report = { message: string; serverName?: string };

const listeners = new Set<(report: Report) => void>();

/**
 * Show a failed Start/Restart: the pids help for that code, a toast
 * otherwise. `serverName` names the server in the help; `namedToast` also
 * puts it in front of the toast (lists of several servers).
 */
export function reportLifecycleError(
  error: unknown,
  fallback: string,
  serverName?: string,
  namedToast = false,
) {
  if (
    error instanceof IpcError &&
    error.code === "PIDS_CONTROLLER_UNAVAILABLE" &&
    listeners.size > 0
  ) {
    listeners.forEach((listener) => listener({ message: error.message, serverName }));
    return;
  }
  const message = error instanceof IpcError ? error.message : fallback;
  toast.danger(namedToast && serverName ? `${serverName}: ${message}` : message);
}

/** The systemd drop-in that delegates the pids controller to user services. */
const LINUX_STEPS = [
  "sudo mkdir -p /etc/systemd/system/user@.service.d",
  "printf '[Service]\\nDelegate=cpu cpuset io memory pids\\n' | sudo tee /etc/systemd/system/user@.service.d/delegate.conf",
  "sudo systemctl daemon-reload",
];

const isLinux = () =>
  typeof navigator !== "undefined" &&
  /Linux/i.test(navigator.userAgent) &&
  !/Android/i.test(navigator.userAgent);

/** The `<runtime> update --pids-limit=0 <name>` command core names when its own lift failed. */
export const liftCommandOf = (message: string): string | null =>
  message.match(/`([^`]*update --pids-limit=0[^`]*)`/)?.[1] ?? null;

function CommandRow({ command }: { command: string }) {
  const { play } = useUISound();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      play("success");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      play("error");
    }
  };
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-lg border border-border py-1 pr-1 pl-3"
      style={{ background: "var(--well)" }}
    >
      <code className="min-w-0 break-all font-mono text-xs">{command}</code>
      <Button
        size="sm"
        variant="ghost"
        isIconOnly
        aria-label={`Copy: ${command}`}
        onPress={copy}
        onMouseEnter={() => play("hover")}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
    </div>
  );
}

export default function PidsControllerHelp() {
  const { play } = useUISound();
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    const listener = (next: Report) => {
      play("error");
      setReport(next);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [play]);

  const close = () => {
    play("click_back");
    setReport(null);
  };

  const liftCommand = report ? liftCommandOf(report.message) : null;
  const server = report?.serverName ?? "The server";

  return (
    <AlertDialog.Backdrop
      isOpen={report !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      isDismissable
      isKeyboardDismissDisabled={false}
      variant="blur"
    >
      <AlertDialog.Container>
        <AlertDialog.Dialog className="sm:max-w-[560px]">
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading className="font-pixel text-sm uppercase tracking-[0.2em]">
              The container could not start
            </AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body className="grid gap-4 text-sm">
            <p className="text-muted">
              {server} did not start because the container runtime (crun) needs the
              Linux <code className="font-mono">pids</code> cgroup controller to apply the
              container&apos;s process limit, and this computer does not give it to
              containers. MineUI already tried lifting that limit.
            </p>

            {liftCommand && (
              <section className="grid gap-2">
                <h3 className="font-medium text-foreground">Lift the limit yourself</h3>
                <p className="text-muted">
                  MineUI could not change the container. Run this in a terminal, then
                  start the server again:
                </p>
                <CommandRow command={liftCommand} />
              </section>
            )}

            {isLinux() ? (
              <section className="grid gap-2">
                <h3 className="font-medium text-foreground">
                  Give containers the pids controller
                </h3>
                <p className="text-muted">
                  This fixes it for every server on this computer. On a system with
                  systemd, run:
                </p>
                {LINUX_STEPS.map((command) => (
                  <CommandRow key={command} command={command} />
                ))}
                <p className="text-muted">
                  Then log out and back in (or restart the computer) and start the
                  server again. Without systemd (OpenRC, or inside WSL), the controller
                  has to be enabled in the cgroup tree above your containers; MineUI
                  cannot do that for you.
                </p>
              </section>
            ) : (
              !liftCommand && (
                <p className="text-muted">
                  On Windows and macOS the controller is set inside the Podman machine,
                  not by MineUI. The runtime&apos;s message below is what to share when
                  asking for help.
                </p>
              )
            )}

            <details className="text-xs text-muted">
              <summary className="cursor-pointer">What the runtime said</summary>
              <p className="mt-2 break-all font-mono">{report?.message}</p>
            </details>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="primary" onPress={close} onMouseEnter={() => play("hover")}>
              Close
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
