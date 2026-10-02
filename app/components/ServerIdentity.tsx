"use client";

// The open server, named properly (docs/theme-contract.md §9 page header):
// status dot, the name the user gave it, then what it actually is — loader
// and version, container, address — so "Forge" and "Forge test" are never
// confused. Data comes from ServerProvider's live overview.
import {
  identityLine,
  phaseDotClass,
  phaseText,
  useServers,
} from "@/app/components/ServerProvider";

export default function ServerIdentity({ className = "" }: { className?: string }) {
  const { active, activeId, overview } = useServers();
  const entry = overview.find((item) => item.id === activeId);
  const detail = identityLine(entry);
  return (
    <span
      className={`flex min-w-0 items-center gap-2 ${className}`}
      title={detail ? `${active.name} — ${detail}` : active.name}
    >
      <span
        role="img"
        aria-label={phaseText(entry?.phase)}
        className={`size-2 shrink-0 rounded-full ${phaseDotClass(entry?.phase)}`}
      />
      <span className="shrink-0 text-sm font-semibold text-foreground">{active.name}</span>
      {detail && <span className="truncate font-mono text-xs text-muted">{detail}</span>}
    </span>
  );
}
