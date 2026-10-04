"use client";

// Header control (docs/theme-contract.md §9.1 controls zone): which server
// the pages are showing, with every server's live state one click away.
// Server profiles are contract §2.5; the state lives in ServerProvider.
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Settings2 } from "lucide-react";
import {
  Button,
  Description,
  Dropdown,
  Header,
  Label,
  Separator,
  Tooltip,
} from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";
import {
  identityLine,
  overviewSummary,
  phaseDotClass,
  phaseText,
  useServers,
} from "@/app/components/ServerProvider";
import { leaveOr } from "@/app/lib/leaveGuard";

const MANAGE_KEY = "__manage";

export default function ServerSwitcher() {
  const router = useRouter();
  const { play } = useUISound();
  const { servers, active, activeId, overview, switching, switchTo } = useServers();
  const stateOf = (id: string) => overview.find((entry) => entry.id === id);
  const activeState = stateOf(activeId);

  const handleAction = (key: string) => {
    play("click_confirm");
    if (key === MANAGE_KEY) {
      leaveOr(() => router.push("/app-settings#servers"));
      return;
    }
    switchTo(key);
  };

  return (
    // Tooltip outside, the Button as the Dropdown's direct child - same
    // PressResponder constraint as the More overflow in Navbar.tsx.
    <Tooltip delay={400}>
      <Dropdown trigger="press">
        <Button
          size="sm"
          variant="ghost"
          isDisabled={switching}
          // The name span is CSS-hidden below header-mid, so this is the
          // control's real accessible name at the narrow tiers.
          aria-label={`Server: ${active.name} (${phaseText(activeState?.phase)}). Switch server`}
          onMouseEnter={() => play("hover")}
        >
          <span
            aria-hidden
            className={`size-2 shrink-0 rounded-full ${phaseDotClass(activeState?.phase)}`}
          />
          <span className="hidden max-w-28 truncate header-mid:inline">
            {active.name}
          </span>
          <ChevronsUpDown size={14} className="shrink-0 text-muted" />
        </Button>
        <Dropdown.Popover placement="bottom end" className="min-w-72">
          <Dropdown.Menu
            aria-label="Servers"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[activeId]}
            onAction={(key) => handleAction(String(key))}
          >
            <Dropdown.Section>
              <Header>Servers</Header>
              {servers.map((server) => {
                const state = stateOf(server.id);
                return (
                  <Dropdown.Item key={server.id} id={server.id} textValue={server.name}>
                    <span
                      aria-hidden
                      className={`size-2 shrink-0 rounded-full ${phaseDotClass(state?.phase)}`}
                    />
                    <div className="flex min-w-0 flex-col">
                      <Label className="truncate">{server.name}</Label>
                      <Description>{overviewSummary(state)}</Description>
                      {state && (
                        <Description className="font-mono">{identityLine(state)}</Description>
                      )}
                    </div>
                    <Dropdown.ItemIndicator />
                  </Dropdown.Item>
                );
              })}
            </Dropdown.Section>
            <Separator />
            <Dropdown.Item id={MANAGE_KEY} textValue="Manage servers">
              <Settings2 size={16} />
              <Label>Manage servers…</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <Tooltip.Content placement="bottom">
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{active.name}</span>
          <span className="text-muted">
            {servers.length > 1
              ? `Showing 1 of ${servers.length} servers - switch or manage`
              : "Add another server to manage several at once"}
          </span>
        </span>
      </Tooltip.Content>
    </Tooltip>
  );
}
