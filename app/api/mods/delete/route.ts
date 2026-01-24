import { NextResponse } from "next/server";
import { runPodman } from "@/app/api/_utils/podman";
import { getServerConfig } from "@/app/lib/serverConfig";

type DeletePayload = {
  filename?: string;
  target?: "mods" | "plugins";
};

const isSafeFilename = (value: string) => {
  if (!value.trim()) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return false;
  return true;
};

export const POST = async (request: Request) => {
  try {
    const body = (await request.json()) as DeletePayload;
    const filename = body.filename ?? "";
    const target = body.target ?? "mods";

    if (!isSafeFilename(filename)) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    if (target !== "mods" && target !== "plugins") {
      return NextResponse.json({ error: "Invalid target" }, { status: 400 });
    }

    const config = await getServerConfig();
    const basePath = target === "mods" ? "/data/mods" : "/data/plugins";
    const fullPath = `${basePath}/${filename}`;

    await runPodman(["exec", config.containerName, "rm", "-f", "--", fullPath]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Delete failed:", error);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
};
