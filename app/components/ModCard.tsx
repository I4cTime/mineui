"use client";

// One mod or plugin on the Mods page: name, a few facts, copy / delete.
import { motion, type Variants } from "motion/react";
import { Copy, Trash2 } from "lucide-react";
import { Button, Card, Chip, Tooltip } from "@heroui/react";
import { formatBytes, formatDateTime } from "@/app/lib/format";
import { useUISound } from "@/app/hooks/useUISound";
import type { ModEntry, ModTarget } from "@/app/lib/ipc";

const LOADER_NAMES: Record<string, string> = {
  neoforge: "NeoForge",
  forge: "Forge",
  fabric: "Fabric",
  quilt: "Quilt",
};

export const loaderName = (loader: string | null | undefined): string | null =>
  loader ? (LOADER_NAMES[loader] ?? loader.charAt(0).toUpperCase() + loader.slice(1)) : null;

const fileTypeBadge = (filename: string) => {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jar.disabled")) return "Disabled";
  if (lower.endsWith(".jar")) return "JAR";
  if (lower.endsWith(".zip")) return "ZIP";
  return "File";
};

interface ModCardProps {
  item: ModEntry;
  kind: ModTarget;
  /** The active server's loader ("forge", "fabric", …) or null when unknown. */
  serverLoader: string | null;
  copied: boolean;
  deleting: boolean;
  index: number;
  variants: Variants;
  onCopy: (filename: string) => void;
  onDelete: (item: ModEntry, kind: ModTarget) => void;
}

export default function ModCard({
  item,
  kind,
  serverLoader,
  copied,
  deleting,
  index,
  variants,
  onCopy,
  onDelete,
}: ModCardProps) {
  const { play } = useUISound();
  const known = item.loader !== "unknown";
  // Only the three real mod loaders can contradict each other; a modpack or
  // vanilla server reports something else and gets no warning.
  const serverKnown = serverLoader !== null && serverLoader in LOADER_NAMES;
  const mismatch = known && serverKnown && item.loader !== serverLoader;
  const disabled = item.filename.toLowerCase().endsWith(".jar.disabled");

  return (
    <motion.div variants={variants} custom={index}>
      <Card className="p-4 text-sm" variant={kind === "mods" ? "secondary" : "default"}>
        <Card.Header className="gap-1">
          <Card.Title className="text-base">{item.name}</Card.Title>
          <Card.Description className="text-xs text-muted">
            Updated {formatDateTime(item.updatedAtEpochMs)}
          </Card.Description>
        </Card.Header>
        <Card.Content className="mt-3 flex flex-row flex-wrap gap-2 text-xs">
          <Chip variant="soft">Size: {formatBytes(item.sizeBytes)}</Chip>
          {known && <Chip variant="soft">Loader: {loaderName(item.loader)}</Chip>}
          {mismatch && (
            <Chip variant="soft" color="warning">
              Made for {loaderName(item.loader)} - this server runs {loaderName(serverLoader)}
            </Chip>
          )}
          {disabled ? (
            <Tooltip delay={300}>
              <Tooltip.Trigger className="inline-flex rounded-full">
                <Chip variant="soft" color="warning">
                  Disabled
                </Chip>
              </Tooltip.Trigger>
              <Tooltip.Content placement="top">
                <span className="block max-w-72 break-normal">
                  A file ending in .disabled is ignored by the server. Rename it back to .jar
                  to use it again.
                </span>
              </Tooltip.Content>
            </Tooltip>
          ) : (
            <Chip variant="soft">{fileTypeBadge(item.filename)}</Chip>
          )}
          <Chip variant="soft" className="max-w-full">
            <span className="truncate">File: {item.filename}</span>
          </Chip>
        </Card.Content>
        <Card.Footer className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onPress={() => onCopy(item.filename)}
            onMouseEnter={() => play("hover")}
          >
            <Copy size={12} />
            {copied ? "Copied" : "Copy file name"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger hover:text-danger-soft-foreground"
            isDisabled={deleting}
            onPress={() => onDelete(item, kind)}
            onMouseEnter={() => play("hover")}
          >
            <Trash2 size={12} />
            Delete
          </Button>
        </Card.Footer>
      </Card>
    </motion.div>
  );
}
