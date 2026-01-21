import { NextResponse } from "next/server";
import { runPodman } from "@/app/api/_utils/podman";
import { getServerConfig } from "@/app/lib/serverConfig";

export const POST = async () => {
  const config = await getServerConfig();
  try {
    await runPodman(["restart", config.containerName]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restart failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
