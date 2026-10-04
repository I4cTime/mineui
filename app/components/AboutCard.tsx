"use client";

// App Settings → About: which MineUI this is, where it keeps its files, the
// links people look for, and a manual update check. Nothing here contacts
// the network unless "Check for updates" is pressed (contract §3.15).
import { useEffect, useState } from "react";
import { ArrowUpCircle, Check, Copy, ExternalLink, FolderOpen, Info, Loader2, RefreshCw } from "lucide-react";
import { Button, Card, Chip, toast } from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";
import {
  checkForUpdate,
  getAppInfo,
  openAppDir,
  openUrl,
  IpcError,
  type AppInfo,
  type UpdateCheck,
} from "@/app/lib/ipc";

const LINKS: { label: string; url: string }[] = [
  { label: "Website and guides", url: "https://mineui.i4c.studio" },
  { label: "What's new (changelog)", url: "https://mineui.i4c.studio/changelog" },
  { label: "Report a problem", url: "https://github.com/I4cTime/mineui/issues" },
  { label: "Source code and license (MIT)", url: "https://github.com/I4cTime/mineui" },
];

const OS_NAMES: Record<string, string> = { linux: "Linux", windows: "Windows", macos: "macOS" };

const messageOf = (error: unknown, fallback: string) =>
  error instanceof IpcError ? error.message : fallback;

export default function AboutCard() {
  const { play } = useUISound();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    getAppInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const open = (url: string) => {
    play("click_confirm");
    openUrl(url).catch((error: unknown) => {
      play("error");
      toast.danger(messageOf(error, "Could not open the link"));
    });
  };

  const openDir = (which: "data" | "config") => {
    play("click_confirm");
    openAppDir(which).catch((error: unknown) => {
      play("error");
      toast.danger(messageOf(error, "Could not open the folder"));
    });
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      play("success");
      setCopied(text);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      play("error");
    }
  };

  const check = async () => {
    play("click_confirm");
    setChecking(true);
    setUpdateError(null);
    try {
      const result = await checkForUpdate();
      setUpdate(result);
      play(result.newer ? "notification" : "success");
    } catch (error) {
      play("error");
      setUpdate(null);
      setUpdateError(messageOf(error, "Could not check for updates."));
    } finally {
      setChecking(false);
    }
  };

  const folders: { which: "data" | "config"; label: string; hint: string; path: string }[] = info
    ? [
        { which: "data", label: "Data folder", hint: "Server files, backups, logs", path: info.dataDir },
        { which: "config", label: "Settings folder", hint: "MineUI's own settings", path: info.configDir },
      ]
    : [];

  return (
    <Card className="p-6">
      <Card.Header className="flex-col items-start gap-1">
        <div className="flex items-center gap-2">
          <Info size={16} className="text-accent" />
          <Card.Title>About MineUI</Card.Title>
        </div>
        <Card.Description>
          Free and open source. Not affiliated with Mojang or Microsoft.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-4 grid gap-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">
            Version{" "}
            <span className="font-pixel-num text-base font-semibold">{info?.version ?? "-"}</span>
          </span>
          {info && (
            <span className="text-xs text-muted">
              {OS_NAMES[info.os] ?? info.os} · {info.arch}
            </span>
          )}
          <Button
            size="sm"
            variant="secondary"
            isDisabled={checking}
            onPress={check}
            onMouseEnter={() => play("hover")}
          >
            {checking ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            Check for updates
          </Button>
          {update && !update.newer && (
            <Chip size="sm" variant="soft" color="success">
              <Check size={12} /> You have the latest version
            </Chip>
          )}
        </div>

        {update?.newer && (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent p-3 text-sm"
          >
            <span className="flex items-center gap-2">
              <ArrowUpCircle size={16} className="text-accent" />
              <span>
                MineUI <span className="font-pixel-num">{update.latest}</span> is available - you
                have <span className="font-pixel-num">{update.current}</span>.
              </span>
            </span>
            <Button size="sm" onPress={() => open(update.url)}>
              <ExternalLink size={14} />
              Open the download page
            </Button>
          </div>
        )}
        {updateError && (
          <p role="alert" className="text-xs text-danger">
            {updateError}
          </p>
        )}
        <p className="-mt-3 text-xs text-muted">
          MineUI never checks on its own - only when you press the button. It asks GitHub for
          the newest release and sends nothing about you or your servers.
        </p>

        {folders.length > 0 && (
          <div className="grid gap-3">
            <span className="text-sm font-semibold">Where MineUI keeps its files</span>
            {folders.map((folder) => (
              <div
                key={folder.which}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                style={{ background: "var(--surface-secondary)" }}
              >
                <div className="grid min-w-0 gap-0.5">
                  <span className="text-sm">
                    {folder.label} <span className="text-xs text-muted">- {folder.hint}</span>
                  </span>
                  <span className="break-all font-mono text-xs text-muted">{folder.path}</span>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Copy the path of the ${folder.label.toLowerCase()}`}
                    onPress={() => copy(folder.path)}
                  >
                    {copied === folder.path ? <Check size={14} /> : <Copy size={14} />}
                    Copy path
                  </Button>
                  <Button size="sm" variant="ghost" onPress={() => openDir(folder.which)}>
                    <FolderOpen size={14} />
                    Open
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {LINKS.map((link) => (
            <Button
              key={link.url}
              size="sm"
              variant="ghost"
              onPress={() => open(link.url)}
              onMouseEnter={() => play("hover")}
            >
              <ExternalLink size={14} />
              {link.label}
            </Button>
          ))}
        </div>
      </Card.Content>
    </Card>
  );
}
