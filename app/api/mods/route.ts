import { NextResponse } from "next/server";
import { runPodman, safeList } from "@/app/api/_utils/podman";
import { getServerConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

type ModEntry = {
  name: string;
  filename: string;
  sizeBytes: number;
  updatedAt: number;
  loader: "forge" | "neoforge" | "fabric" | "unknown";
};

const detectLoader = (filename: string): ModEntry["loader"] => {
  const lower = filename.toLowerCase();
  if (lower.includes("neoforge")) return "neoforge";
  if (lower.includes("forge")) return "forge";
  if (lower.includes("fabric")) return "fabric";
  return "unknown";
};

const toDisplayName = (filename: string) => {
  return filename
    .replace(/\.(jar|zip|jar\.disabled)$/i, "")
    .replace(/[_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const listDir = async (path: string) => {
  try {
    const config = await getServerConfig();
    const { stdout } = await runPodman([
      "exec",
      config.containerName,
      "sh",
      "-c",
      `ls -1 ${path} 2>/dev/null || true`,
    ]);
    return safeList(stdout);
  } catch {
    return [];
  }
};

const listEntries = async (path: string) => {
  try {
    const config = await getServerConfig();
    const { stdout } = await runPodman([
      "exec",
      config.containerName,
      "sh",
      "-c",
      `for f in ${path}/*; do [ -f "$f" ] || continue; stat -c "%n|%s|%Y" "$f"; done`,
    ]);
    const lines = safeList(stdout);
    return lines
      .map((line) => {
        const [fullPath, sizeRaw, updatedRaw] = line.split("|");
        const filename = fullPath?.split("/").pop() ?? "";
        if (!filename) return null;
        return {
          name: toDisplayName(filename),
          filename,
          sizeBytes: Number(sizeRaw ?? 0),
          updatedAt: Number(updatedRaw ?? 0),
          loader: detectLoader(filename),
        } satisfies ModEntry;
      })
      .filter((entry): entry is ModEntry => Boolean(entry));
  } catch {
    return [] as ModEntry[];
  }
};

export const GET = async () => {
  const [mods, plugins] = await Promise.all([
    listEntries("/data/mods"),
    listEntries("/data/plugins"),
  ]);
  const [rawMods, rawPlugins] = await Promise.all([
    listDir("/data/mods"),
    listDir("/data/plugins"),
  ]);
  return NextResponse.json({
    mods,
    plugins,
    raw: {
      mods: rawMods,
      plugins: rawPlugins,
    },
  });
};
