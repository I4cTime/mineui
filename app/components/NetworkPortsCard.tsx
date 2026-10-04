"use client";

// Server Settings (advanced mode): who can reach the server and which extra
// ports it publishes. Not part of the page's draft/Save bar - a container
// cannot change its published ports, so applying rebuilds it (contract
// §3.16): own Apply button, confirmed first, server stopped.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Network, RefreshCw } from "lucide-react";
import { Button, Card, Label, Switch, toast } from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PortsEditor, { portsProblems } from "@/app/components/PortsEditor";
import { useServers } from "@/app/components/ServerProvider";
import ServerStateNotice from "@/app/components/ServerStateNotice";
import { useUISound } from "@/app/hooks/useUISound";
import {
  getJoinInfo,
  updateContainerPorts,
  IpcError,
  type ExtraPort,
  type JoinInfo,
} from "@/app/lib/ipc";

/** What "Let other devices join" does, in a sentence. Shared with the create flow. */
export const exposeConsequence = (expose: boolean, gamePort: number) =>
  expose
    ? `The game port (${gamePort}) is opened on every network interface of this machine.`
    : "Only this computer can connect. Choose this for a test server.";

const portsKey = (ports: ExtraPort[]) =>
  ports
    .map((item) => `${item.port}/${item.protocol}`)
    .sort()
    .join(",");

const toExtra = (info: JoinInfo): ExtraPort[] =>
  info.extraPorts.map(({ port, protocol }) => ({ port, protocol }));

export default function NetworkPortsCard({ rconPort }: { rconPort: number }) {
  const { play } = useUISound();
  const { activeId, overview, refreshOverview } = useServers();
  const phase = overview.find((item) => item.id === activeId)?.phase ?? null;
  const stopped = phase === "stopped" || phase === "crashed";

  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [expose, setExpose] = useState(false);
  const [ports, setPorts] = useState<ExtraPort[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getJoinInfo();
      setInfo(next);
      setFailure(null);
      setExpose(next.reach === "network");
      setPorts(toExtra(next));
    } catch (error) {
      setInfo(null);
      setFailure(error instanceof IpcError ? error.message : "MineUI could not find out.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount (and on a switch of server)
    void load();
  }, [load, activeId]);

  // `/settings#network` from the dashboard: the card mounts after the page's
  // own load, so the browser's hash scroll has nothing to land on yet.
  const ready = info !== null;
  useEffect(() => {
    if (ready && window.location.hash === "#network") {
      document.getElementById("network")?.scrollIntoView({ block: "start" });
    }
  }, [ready]);

  const gamePort = info?.port ?? 25565;
  const problems = useMemo(
    () => portsProblems(ports, gamePort, rconPort),
    [ports, gamePort, rconPort],
  );
  const dirty =
    info !== null &&
    (expose !== (info.reach === "network") || portsKey(ports) !== portsKey(toExtra(info)));
  const editable = info?.canChangePorts === true;
  const canApply = editable && dirty && stopped && problems.length === 0 && !applying;

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await updateContainerPorts(expose, ports);
      play("success");
      toast.success("Ports updated. Start the server to use them.");
      setConfirmOpen(false);
      await Promise.all([load(), refreshOverview()]);
    } catch (error) {
      play("error");
      const message =
        error instanceof IpcError ? error.message : "Could not change the ports.";
      setApplyError(message);
      toast.danger(message);
      setConfirmOpen(false);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Card className="p-6" id="network">
      <Card.Header className="flex-col items-start gap-1">
        <div className="flex items-center gap-2">
          <Network size={16} className="text-accent" />
          <Card.Title>Network and ports</Card.Title>
        </div>
        <Card.Description>
          Who can connect to this server, and which extra ports mods can use. Changing
          these rebuilds the container, so it has its own Apply button.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-4 grid gap-4 text-sm">
        {info === null ? (
          <p className="text-muted" role={failure ? "alert" : "status"}>
            {failure
              ? `MineUI could not read the port settings: ${failure}`
              : "Reading the port settings..."}
          </p>
        ) : (
          <>
            {!editable && (
              <p
                role="status"
                className="rounded-lg border border-border p-3 text-xs text-muted"
              >
                {info.whyNot ?? "MineUI cannot change the ports of this container."} What
                is set now is shown below.
              </p>
            )}

            <div className="grid gap-2">
              <Switch
                isSelected={expose}
                isDisabled={!editable || applying}
                onChange={(selected: boolean) => {
                  play(selected ? "toggle_on" : "toggle_off");
                  setExpose(selected);
                }}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>Let other devices join</Label>
                </Switch.Content>
              </Switch>
              <span className="text-xs text-muted">
                {exposeConsequence(expose, gamePort)} The connection MineUI uses to control the
                server always stays on this computer.
              </span>
            </div>

            <div className="grid gap-2">
              <span className="text-xs uppercase tracking-[0.2em] text-muted">Extra ports</span>
              <PortsEditor
                value={ports}
                onChange={setPorts}
                gamePort={gamePort}
                rconPort={rconPort}
                isDisabled={!editable || applying}
              />
            </div>

            {editable && <ServerStateNotice need="stopped" what="to change its ports" />}

            {applyError && (
              <p role="alert" className="text-xs text-danger">
                {applyError}
              </p>
            )}

            {editable && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  isDisabled={!canApply}
                  onPress={() => {
                    play("click_confirm");
                    setConfirmOpen(true);
                  }}
                  onMouseEnter={() => play("hover")}
                >
                  Apply
                </Button>
                {dirty && (
                  <Button
                    variant="ghost"
                    isDisabled={applying}
                    onPress={() => {
                      play("click_back");
                      setApplyError(null);
                      setExpose(info.reach === "network");
                      setPorts(toExtra(info));
                    }}
                    onMouseEnter={() => play("hover")}
                  >
                    <RefreshCw size={14} />
                    Undo changes
                  </Button>
                )}
                {dirty && problems.length > 0 && (
                  <span className="text-xs text-muted">Fix the ports above first.</span>
                )}
              </div>
            )}
          </>
        )}
        <ConfirmDialog
          isOpen={confirmOpen}
          title="Rebuild the container with these ports"
          description="MineUI rebuilds the container with the new port settings. The world, mods, settings and backups are kept - they live in the server's data volume, which is not touched. The server stays stopped; start it again when this is done."
          confirmLabel="Rebuild container"
          cancelLabel="Cancel"
          isLoading={applying}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void apply()}
        />
      </Card.Content>
    </Card>
  );
}
