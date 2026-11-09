"use client";

// "Get Java for me": MineUI downloads the Java a Minecraft version needs into
// its own folder (install_java, contract 2.13.0) and shows the progress. Used
// by Start here, the Create server flow and a failed Start on the Dashboard.
// The caller decides when Java is "ready" from the JavaCheck handed back.
import { useState } from "react";
import { CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";
import { Button, ProgressBar } from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";
import { formatBytes } from "@/app/lib/format";
import {
  installJava,
  IpcError,
  onDownloadProgress,
  type DownloadProgressEvent,
  type JavaCheck,
} from "@/app/lib/ipc";

interface GetJavaForMeProps {
  /** The Java major the Minecraft version needs. */
  major: number;
  /** Called with the Java check after a successful download. */
  onInstalled: (check: JavaCheck) => void;
  isDisabled?: boolean;
  /** Button text; defaults to "Get Java for me". */
  label?: string;
}

export default function GetJavaForMe({
  major,
  onInstalled,
  isDisabled = false,
  label = "Get Java for me",
}: GetJavaForMeProps) {
  const { play } = useUISound();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const run = async () => {
    play("click_confirm");
    setBusy(true);
    setError(null);
    setProgress(null);
    const unlisten = await onDownloadProgress((event) => {
      if (event.kind === "java") setProgress(event);
    });
    try {
      const check = await installJava(major);
      play("success");
      setDone(true);
      onInstalled(check);
    } catch (e) {
      play("error");
      setError(
        e instanceof IpcError
          ? e.message
          : "MineUI could not download Java. Check your internet and try again.",
      );
    } finally {
      unlisten();
      setBusy(false);
    }
  };

  const percent =
    progress && progress.totalBytes
      ? Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)
      : null;

  return (
    <div className="grid gap-2" data-testid="get-java">
      {done ? (
        <span className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 size={16} />
          Java {major} is ready.
        </span>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onPress={run}
            isDisabled={busy || isDisabled}
            onMouseEnter={() => play("hover")}
          >
            {busy ? (
              <Loader2 size={16} className="animate-spin" />
            ) : error ? (
              <RefreshCw size={16} />
            ) : (
              <Download size={16} />
            )}
            {busy ? "Getting Java..." : error ? "Try again" : label}
          </Button>
          {!busy && !error && (
            <span className="text-xs text-muted">
              Free download (about 50 MB). MineUI keeps it in its own folder.
            </span>
          )}
        </div>
      )}

      {busy && (
        <div className="grid gap-1.5" role="status">
          <div className="flex items-center justify-between text-xs text-muted">
            <span>{progress ? `Downloading ${progress.filename}` : "Starting the download..."}</span>
            <span>
              {progress
                ? progress.totalBytes
                  ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                  : formatBytes(progress.receivedBytes)
                : ""}
            </span>
          </div>
          <ProgressBar
            className="progress-bar-steps"
            aria-label="Java download progress"
            value={percent ?? 0}
            isIndeterminate={percent === null}
          >
            <ProgressBar.Track>
              <ProgressBar.Fill />
            </ProgressBar.Track>
          </ProgressBar>
        </div>
      )}

      {error && (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
