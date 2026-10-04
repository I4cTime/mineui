"use client";

// Dashboard card "How players join": the exact address to type for the three
// places a player can be - this computer, the same home network, the
// internet - and which extra (mod) ports are open. The old "127.0.0.1:25565"
// line was the server's address only for this computer; anyone else who
// typed it could not connect. The public address is looked up only when the
// user asks (contract §3.16).
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Check, Copy, Globe, Loader2, Users } from "lucide-react";
import { Alert, Button, Card, Chip, Disclosure, toast } from "@heroui/react";
import OutLink from "@/app/components/OutLink";
import { useServers } from "@/app/components/ServerProvider";
import { useUISound } from "@/app/hooks/useUISound";
import {
  getJoinInfo,
  getPublicAddress,
  IpcError,
  type JoinInfo,
  type PortReach,
} from "@/app/lib/ipc";

/** Podman on Windows keeps its containers inside WSL, which sits behind its
 *  own virtual network. Wording is final-pending: keep it all in here. */
const WSL_LAN_NOTE = {
  title: "Windows setup needed for other devices",
  intro:
    "With Podman on Windows the server runs inside WSL, which other devices on your network cannot reach until Windows is set up for it. Two ways, both described in Microsoft's guide:",
  mirrored:
    "Mirrored networking (Windows 11 22H2 or newer). Works for every port.",
  forward:
    "Port forwarding from Windows to WSL. TCP only: fine for the game port, not for a UDP port such as voice chat.",
  udp: "Voice chat and other UDP ports may not connect with this setup. If so, try mirrored networking or Docker Desktop.",
};

type Os = "windows" | "mac" | "linux";

const detectOs = (): Os => {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "mac";
  return "linux";
};

const FIREWALL_LINE: Record<Os, string> = {
  windows:
    "The first time, Windows asks whether to allow access - choose Allow on private networks.",
  linux: "If a firewall is on (ufw or firewalld), allow the port in it.",
  mac: "If the firewall is on, allow incoming connections for the server.",
};

const DEFAULT_PORT = 25565;

const withPort = (host: string, port: number) => `${host}:${port}`;

const reachText = (reach: PortReach) =>
  reach === "network"
    ? "open to your network"
    : reach === "this-computer"
      ? "this computer only"
      : "could not be determined";

function CopyButton({ text, label }: { text: string; label: string }) {
  const { play } = useUISound();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      aria-label={`Copy ${label}`}
      onPress={async () => {
        try {
          await navigator.clipboard.writeText(text);
          play("success");
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          play("error");
        }
      }}
      onMouseEnter={() => play("hover")}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** One place a player can be: what to call it, what to type, what to know. */
function Row({
  title,
  address,
  copyLabel,
  children,
}: {
  title: string;
  address?: string;
  copyLabel?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className="grid gap-1.5 rounded-lg border border-border p-3"
      style={{ background: "var(--surface-secondary)" }}
    >
      <span className="text-sm font-semibold">{title}</span>
      {address && (
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 break-all font-mono text-sm">{address}</span>
          <CopyButton text={address} label={copyLabel ?? title} />
        </div>
      )}
      {children}
    </div>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs text-muted">{children}</p>
);

export default function JoinInfoCard({ online }: { online: boolean }) {
  const router = useRouter();
  const { play } = useUISound();
  const { activeId, overview } = useServers();
  const phase = overview.find((item) => item.id === activeId)?.phase ?? null;
  const os = useSyncExternalStore(
    () => () => {},
    detectOs,
    () => "linux" as Os,
  );
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [internetOpen, setInternetOpen] = useState(false);
  const [looking, setLooking] = useState(false);
  const [publicIp, setPublicIp] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const load = useCallback(() => {
    getJoinInfo()
      .then((next) => {
        setInfo(next);
        setFailure(null);
      })
      .catch((error: unknown) => {
        setInfo(null);
        setFailure(error instanceof IpcError ? error.message : "MineUI could not find out.");
      });
  }, []);

  // On mount, on a switch of server, and whenever the server changes phase.
  useEffect(() => {
    load();
  }, [load, activeId, phase]);

  // The looked-up address belongs to the network, not to the server: keep it
  // across phases but drop it when the player switches to another server.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset the lookup when the server changes
    setPublicIp(null);
  }, [activeId]);

  const lookUp = async () => {
    play("click_confirm");
    setLooking(true);
    setLookupError(null);
    try {
      const result = await getPublicAddress();
      setPublicIp(result.ip);
      play("success");
    } catch (error) {
      play("error");
      const message =
        error instanceof IpcError ? error.message : "Could not look up your public address.";
      setLookupError(message);
      toast.danger(message);
    } finally {
      setLooking(false);
    }
  };

  const port = info?.port ?? DEFAULT_PORT;
  const lan = info?.lanAddresses ?? [];
  const lanPrimary = lan[0] ?? null;
  const localAddress = port === DEFAULT_PORT ? "localhost" : withPort("localhost", port);

  return (
    <Card className="p-5">
      <Card.Header className="flex-col items-start gap-1">
        <div className="flex items-center gap-2 text-sm text-accent">
          <Users size={18} />
          <Card.Title>How players join</Card.Title>
        </div>
        <Card.Description>
          In Minecraft, choose Multiplayer, then Direct Connection (or Add Server) and type
          the address that matches where the player is.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-4 grid gap-3">
        {info === null ? (
          <p className="text-sm text-muted" role={failure ? "alert" : "status"}>
            {failure
              ? `MineUI could not work out how players join: ${failure}`
              : "Checking how players can reach this server..."}
          </p>
        ) : (
          <>
            <Row title="On this computer" address={localAddress} copyLabel="the address for this computer">
              <Muted>
                {online
                  ? "For playing on the same computer the server runs on."
                  : "For playing on the same computer the server runs on. It works once the server is online."}
                {port === DEFAULT_PORT &&
                  " 25565 is Minecraft's default, so it can be left out."}
              </Muted>
            </Row>

            <Row
              title="On your home network (same Wi-Fi or cable)"
              address={
                info.reach === "network" && lanPrimary ? withPort(lanPrimary, port) : undefined
              }
              copyLabel="the address for your home network"
            >
              {info.reach === "network" && lanPrimary && (
                <>
                  <Muted>
                    For family and friends on the same Wi-Fi or cable as this computer.
                  </Muted>
                  {lan.length > 1 && (
                    <Muted>
                      This computer has other addresses too, in case the first one does not
                      work:{" "}
                      <span className="font-mono">
                        {lan
                          .slice(1)
                          .map((item) => withPort(item, port))
                          .join(", ")}
                      </span>
                    </Muted>
                  )}
                  <Muted>{FIREWALL_LINE[os]}</Muted>
                </>
              )}
              {info.reach === "network" && !lanPrimary && (
                <Muted>This computer does not seem to be connected to a network.</Muted>
              )}
              {info.reach === "this-computer" && (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Muted>
                    Only this computer can connect right now.
                    {!info.canChangePorts && info.whyNot ? ` ${info.whyNot}` : ""}
                  </Muted>
                  {info.canChangePorts && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() => {
                        play("click_confirm");
                        router.push("/settings#network");
                      }}
                      onMouseEnter={() => play("hover")}
                    >
                      Let other devices join...
                    </Button>
                  )}
                </div>
              )}
              {info.reach === "unknown" && (
                <Muted>
                  MineUI could not tell who can connect. That happens when the server is not
                  set up yet, or when the program that runs it (Podman or Docker) cannot be
                  reached right now.
                </Muted>
              )}
              {lan.length === 0 && info.reach !== "network" && (
                <Muted>This computer does not seem to be connected to a network.</Muted>
              )}
              {info.wslNat && (
                <Alert
                  status="warning"
                  role="note"
                  className="mt-1 rounded-lg border border-warning bg-transparent p-3 shadow-none"
                >
                  <Alert.Indicator className="p-0 text-warning" />
                  <Alert.Content className="grid min-w-0 gap-1.5 text-sm">
                    <Alert.Title className="text-sm font-semibold leading-normal text-foreground">
                      {WSL_LAN_NOTE.title}
                    </Alert.Title>
                    <Alert.Description className="grid gap-1.5 text-sm text-foreground">
                      <p>{WSL_LAN_NOTE.intro}</p>
                      <ul className="grid list-disc gap-1 pl-5">
                        <li>{WSL_LAN_NOTE.mirrored}</li>
                        <li>{WSL_LAN_NOTE.forward}</li>
                      </ul>
                      {info.extraPorts.some((item) => item.protocol === "udp") && (
                        <p>{WSL_LAN_NOTE.udp}</p>
                      )}
                      <OutLink
                        href="https://learn.microsoft.com/en-us/windows/wsl/networking"
                        className="w-fit text-accent underline underline-offset-2"
                      >
                        WSL networking guide (Microsoft)
                      </OutLink>
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
            </Row>

            <Row title="From the internet (friends elsewhere)">
              <Disclosure
                isExpanded={internetOpen}
                onExpandedChange={(open) => {
                  play(open ? "toggle_on" : "toggle_off");
                  setInternetOpen(open);
                }}
              >
                <Disclosure.Heading>
                  <Disclosure.Trigger
                    className="flex w-fit items-center gap-1.5 text-xs text-accent focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ outlineColor: "var(--focus)" }}
                  >
                    <Globe size={13} />
                    {internetOpen ? "Hide the steps" : "Show the steps"}
                    <Disclosure.Indicator className="ms-0 size-auto">
                      <ChevronDown size={13} />
                    </Disclosure.Indicator>
                  </Disclosure.Trigger>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body style={{ padding: "0.5rem 0 0" }}>
                <div className="grid gap-3">
                  <ol className="grid list-decimal gap-1.5 pl-5 text-xs text-muted">
                    <li>The home network row above has to work first.</li>
                    <li>
                      In your router&apos;s settings, forward <strong>TCP</strong> port{" "}
                      <span className="font-mono">{port}</span> to this computer
                      {lanPrimary && (
                        <>
                          {" "}
                          (<span className="font-mono">{lanPrimary}</span>)
                        </>
                      )}
                      .
                    </li>
                    <li>
                      Friends then type your public address followed by{" "}
                      <span className="font-mono">:{port}</span>.
                    </li>
                  </ol>
                  <div className="grid gap-1.5">
                    {publicIp ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 break-all font-mono text-sm">
                          {withPort(publicIp, port)}
                        </span>
                        <CopyButton
                          text={withPort(publicIp, port)}
                          label="the address for friends on the internet"
                        />
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        className="w-fit"
                        isDisabled={looking}
                        onPress={lookUp}
                        onMouseEnter={() => play("hover")}
                      >
                        {looking && <Loader2 size={14} className="animate-spin" />}
                        Look up my public address
                      </Button>
                    )}
                    <Muted>Asks api.ipify.org for your address - nothing else is sent.</Muted>
                    {lookupError && (
                      <p role="alert" className="text-xs text-danger">
                        {lookupError}
                      </p>
                    )}
                  </div>
                  <Muted>
                    Some internet providers share one address between many customers
                    (CGNAT). If yours does, port forwarding cannot work.
                  </Muted>
                </div>
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            </Row>

            {info.extraPorts.length > 0 && (
              <Row title="Extra ports for mods">
                <ul className="grid gap-1">
                  {info.extraPorts.map((item) => (
                    <li
                      key={`${item.port}/${item.protocol}`}
                      className="flex flex-wrap items-center gap-2 text-sm"
                    >
                      <span className="font-mono">
                        {item.port} {item.protocol.toUpperCase()}
                      </span>
                      <Chip
                        size="sm"
                        variant="soft"
                        color={item.reach === "network" ? "success" : "default"}
                      >
                        {reachText(item.reach)}
                      </Chip>
                    </li>
                  ))}
                </ul>
                <Muted>
                  To reach these from the internet, repeat the router step for each one, with
                  the same port number and the same TCP or UDP.
                </Muted>
              </Row>
            )}
          </>
        )}
      </Card.Content>
    </Card>
  );
}
