import { NextResponse } from "next/server";
import { runPodman } from "@/app/api/_utils/podman";
import { getServerConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

export const GET = async (request: Request) => {
  const { searchParams } = new URL(request.url);
  const tail = Number(searchParams.get("tail") ?? "200");
  const safeTail = Number.isFinite(tail) ? Math.min(Math.max(tail, 10), 1000) : 200;
  try {
    const config = await getServerConfig();
    const { stdout } = await runPodman([
      "logs",
      "--tail",
      safeTail.toString(),
      config.containerName,
    ]);
    return NextResponse.json({
      ok: true,
      lines: stdout ? stdout.split("\n") : [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Logs unavailable";
    return NextResponse.json(
      { ok: false, error: message, lines: [] },
      { status: 500 },
    );
  }
};
