import { NextResponse } from "next/server";
import { runPodman } from "@/app/api/_utils/podman";
import { serverConfig } from "@/app/lib/serverConfig";

export const POST = async () => {
  try {
    await runPodman(["stop", serverConfig.containerName]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stop failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
