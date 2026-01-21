import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPodman } from "@/app/api/_utils/podman";
import { getServerConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

const isAllowedExtension = (name: string) => /\.(jar|zip)$/i.test(name);
const getTargetPath = (target: string | null) =>
  target === "plugins" ? "/data/plugins" : "/data/mods";

const sanitizeFilename = (name: string) => {
  const base = path.basename(name);
  return base.replace(/[^\w.\-+()]/g, "_");
};

export const POST = async (req: Request) => {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const targetRaw = form.get("target");
    const target = typeof targetRaw === "string" ? targetRaw : null;
    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "Missing file" },
        { status: 400 },
      );
    }
    const filename = sanitizeFilename(file.name);
    if (!isAllowedExtension(filename)) {
      return NextResponse.json(
        { ok: false, error: "Only .jar or .zip files are allowed" },
        { status: 400 },
      );
    }
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mineui-"));
    const tmpPath = path.join(tmpDir, filename);
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(tmpPath, buffer);

    const targetPath = getTargetPath(target);
    const config = await getServerConfig();
    await runPodman([
      "cp",
      tmpPath,
      `${config.containerName}:${targetPath}/${filename}`,
    ]);

    await fs.rm(tmpDir, { recursive: true, force: true });
    return NextResponse.json({ ok: true, filename });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
