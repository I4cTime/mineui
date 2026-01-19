import { NextResponse } from "next/server";
import { runPodman } from "@/app/api/_utils/podman";
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

export const POST = async (request: Request) => {
  const body = await request.json().catch(() => ({}));
  const rawPath = typeof body.path === "string" ? body.path : "";
  const content = typeof body.content === "string" ? body.content : "";
  const path = normalize(rawPath);

  if (!path || !isAllowedPath(path) || !isAllowedExtension(path)) {
    return NextResponse.json(
      { ok: false, error: "Path not allowed." },
      { status: 400 },
    );
  }

  if (content.length > 1_500_000) {
    return NextResponse.json(
      { ok: false, error: "File too large." },
      { status: 400 },
    );
  }

  const encoded = Buffer.from(content, "utf-8").toString("base64");

  try {
    await runPodman([
      "exec",
      serverConfig.containerName,
      "sh",
      "-c",
      `printf '%s' "${encoded}" | base64 -d > "${path}"`,
    ]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to write file";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
