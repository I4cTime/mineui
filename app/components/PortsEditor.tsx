"use client";

// Extra ports a container server publishes next to the game port: a mod such
// as Simple Voice Chat listens on a port of its own and nobody can use it
// until that port is published too. Shared by the create flow and the
// Network and ports card. The host port always equals the container port
// (contract §3.16), so a row is just "number + TCP/UDP".
import { ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button, Dropdown, Label, ListBox, NumberField, Select } from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";
import type { ExtraPort, PortProtocol } from "@/app/lib/ipc";

/** Ports that well-known mods listen on, offered under "Common mods".
 *  Only add a mod here after checking its documented default port. */
export const PORT_PRESETS: { label: string; port: number | "game"; protocol: PortProtocol }[] = [
  { label: "Simple Voice Chat", port: 24454, protocol: "udp" },
  // Plasmo Voice's default (port = 0) is "the same number as the game port", over UDP.
  { label: "Plasmo Voice", port: "game", protocol: "udp" },
  { label: "Geyser (Bedrock players)", port: 19132, protocol: "udp" },
  { label: "BlueMap (web map)", port: 8100, protocol: "tcp" },
  { label: "squaremap (web map)", port: 8080, protocol: "tcp" },
  { label: "Dynmap (web map)", port: 8123, protocol: "tcp" },
];

/** The backend refuses more than this many extra ports. */
export const MAX_EXTRA_PORTS = 16;

const isValidPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65535;

/** Everything wrong with the list, as sentences - mirrors the backend check. */
export function portsProblems(value: ExtraPort[], gamePort: number, rconPort: number): string[] {
  const problems: string[] = [];
  if (value.length > MAX_EXTRA_PORTS) {
    problems.push(`At most ${MAX_EXTRA_PORTS} extra ports.`);
  }
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const { port, protocol } of value) {
    const label = `${port} ${protocol.toUpperCase()}`;
    if (!isValidPort(port)) {
      problems.push("A port is a number from 1 to 65535.");
      continue;
    }
    const key = `${port}/${protocol}`;
    if (seen.has(key) && !reported.has(key)) {
      problems.push(`${label} is listed twice.`);
      reported.add(key);
    }
    seen.add(key);
    if (protocol === "tcp" && port === gamePort) {
      problems.push(`${label} is the game port already - pick another number.`);
    }
    if (protocol === "tcp" && port === rconPort) {
      problems.push(`${label} is the port MineUI uses to control the server (RCON) - pick another number.`);
    }
  }
  return [...new Set(problems)];
}

interface PortsEditorProps {
  value: ExtraPort[];
  onChange: (next: ExtraPort[]) => void;
  gamePort: number;
  rconPort: number;
  isDisabled?: boolean;
}

export default function PortsEditor({
  value,
  onChange,
  gamePort,
  rconPort,
  isDisabled = false,
}: PortsEditorProps) {
  const { play } = useUISound();
  const problems = portsProblems(value, gamePort, rconPort);
  const full = value.length >= MAX_EXTRA_PORTS;

  const update = (index: number, patch: Partial<ExtraPort>) =>
    onChange(value.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  return (
    <div className="grid gap-3">
      <p className="text-xs text-muted">
        Some mods need their own port, for example voice chat. The port number and TCP/UDP
        are in the mod&apos;s documentation or its config file.
      </p>

      {value.length === 0 ? (
        <p className="text-xs text-muted">No extra ports.</p>
      ) : (
        <ul className="grid gap-2" aria-label="Extra ports">
          {value.map((item, index) => (
            <li key={index} className="flex flex-wrap items-end gap-2">
              <NumberField
                className="flex w-32 flex-col gap-1"
                minValue={1}
                maxValue={65535}
                step={1}
                formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
                aria-label={`Extra port ${index + 1}`}
                isDisabled={isDisabled}
                value={Number.isFinite(item.port) && item.port > 0 ? item.port : Number.NaN}
                onChange={(next) =>
                  update(index, {
                    port: typeof next === "number" && Number.isFinite(next) ? next : 0,
                  })
                }
              >
                <Label className="text-xs text-muted">Port</Label>
                <NumberField.Group>
                  <NumberField.Input />
                </NumberField.Group>
              </NumberField>
              <div className="flex w-28 flex-col gap-1">
                <Select
                  className="w-full text-sm"
                  aria-label={`Protocol of extra port ${index + 1}`}
                  value={item.protocol}
                  isDisabled={isDisabled}
                  onChange={(next) => {
                    if (next === null) return;
                    play("click_confirm");
                    update(index, { protocol: next as PortProtocol });
                  }}
                >
                  <Label className="text-xs text-muted">Type</Label>
                  <Select.Trigger onMouseEnter={() => play("hover")}>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="tcp" textValue="TCP">
                        TCP
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                      <ListBox.Item id="udp" textValue="UDP">
                        UDP
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={isDisabled}
                aria-label={`Remove extra port ${item.port > 0 ? item.port : index + 1}`}
                onPress={() => {
                  play("click_back");
                  onChange(value.filter((_, i) => i !== index));
                }}
                onMouseEnter={() => play("hover")}
              >
                <Trash2 size={14} />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      {problems.length > 0 && (
        <ul role="alert" className="grid gap-0.5 text-xs text-danger">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          isDisabled={isDisabled || full}
          onPress={() => {
            play("click_confirm");
            onChange([...value, { port: 0, protocol: "tcp" }]);
          }}
          onMouseEnter={() => play("hover")}
        >
          <Plus size={14} />
          Add port
        </Button>
        <Dropdown trigger="press">
          <Button
            size="sm"
            variant="ghost"
            isDisabled={isDisabled || full}
            onMouseEnter={() => play("hover")}
          >
            Common mods
            <ChevronDown size={14} />
          </Button>
          <Dropdown.Popover placement="bottom start" className="min-w-56">
            <Dropdown.Menu
              aria-label="Common mods"
              onAction={(key) => {
                const preset = PORT_PRESETS.find((item) => item.label === String(key));
                if (!preset) return;
                play("click_confirm");
                onChange([
                  ...value,
                  { port: preset.port === "game" ? gamePort : preset.port, protocol: preset.protocol },
                ]);
              }}
            >
              {PORT_PRESETS.map((preset) => (
                <Dropdown.Item key={preset.label} id={preset.label} textValue={preset.label}>
                  <Label>{preset.label}</Label>
                  <span className="ml-auto text-xs text-muted">
                    {preset.port === "game" ? `${gamePort} (game port)` : preset.port}{" "}
                    {preset.protocol.toUpperCase()}
                  </span>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        {full && <span className="text-xs text-muted">That is the most (16).</span>}
      </div>
    </div>
  );
}
