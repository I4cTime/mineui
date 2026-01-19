import { NextResponse } from "next/server";
import { runPodman, safeList } from "@/app/api/_utils/podman";
import { serverConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

const allowedExtensions = new Set([
  ".json",
  ".properties",
  ".txt",
  ".toml",
  ".json5",
  ".ini",
]);

const normalize = (value: string) => value.replace(/\\/g, "/");

const isAllowedPath = (path: string) => {
  if (path === "/data/server.properties") return true;
  return path.startsWith("/data/config/");
};

const isAllowedExtension = (path: string) => {
  const lower = path.toLowerCase();
  for (const ext of allowedExtensions) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
};

export const GET = async () => {
  try {
    const { stdout } = await runPodman([
      "exec",
      serverConfig.containerName,
      "sh",
      "-c",
      "find /data/config -type f 2>/dev/null || true",
    ]);

    const configFiles = safeList(stdout)
      .map(normalize)
      .filter((path) => isAllowedPath(path) && isAllowedExtension(path))
      .sort((a, b) => a.localeCompare(b));

    const serverProps = "/data/server.properties";
    const { stdout: exists } = await runPodman([
      "exec",
      serverConfig.containerName,
      "sh",
      "-c",
      `[ -f "${serverProps}" ] && echo yes || true`,
    ]);

    const files = [
      ...(exists.trim() ? [serverProps] : []),
      ...configFiles,
    ];

    return NextResponse.json({
      ok: true,
      files,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Config list unavailable";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
