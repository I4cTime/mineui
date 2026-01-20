import { NextResponse } from "next/server";
import path from "node:path";
import { runPodman } from "@/app/api/_utils/podman";
import { serverConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

type DownloadRequest = {
  url: string;
  filename?: string;
  target?: "mods" | "plugins";
};

const isAllowedExtension = (name: string) => /\.(jar|zip)$/i.test(name);
const getTargetPath = (target?: string) =>
  target === "plugins" ? "/data/plugins" : "/data/mods";

const sanitizeFilename = (name: string) => {
  const base = path.basename(name);
  return base.replace(/[^\w.\-+()]/g, "_");
};

const escapeShell = (value: string) => value.replace(/'/g, `'\"'\"'`);

export const POST = async (req: Request) => {
  try {
    const body = (await req.json()) as DownloadRequest;
    if (!body?.url) {
      return NextResponse.json(
        { ok: false, error: "Missing url" },
        { status: 400 },
      );
    }
    let url: URL;
    try {
      url = new URL(body.url);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Invalid url" },
        { status: 400 },
      );
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      return NextResponse.json(
        { ok: false, error: "Only http(s) urls are allowed" },
        { status: 400 },
      );
    }
    const inferred = path.basename(url.pathname);
    const filename = sanitizeFilename(body.filename || inferred || "mod.jar");
    if (!isAllowedExtension(filename)) {
      return NextResponse.json(
        { ok: false, error: "Only .jar or .zip files are allowed" },
        { status: 400 },
      );
    }
    const safeFilename = escapeShell(filename);
    const safeUrl = escapeShell(url.toString());
    const targetPath = getTargetPath(body.target);
    await runPodman([
      "exec",
      serverConfig.containerName,
      "sh",
      "-c",
      `cd ${targetPath} && curl -L -o '${safeFilename}' '${safeUrl}'`,
    ]);
    return NextResponse.json({ ok: true, filename });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Download failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
