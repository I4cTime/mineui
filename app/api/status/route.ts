import { NextResponse } from "next/server";
import { status } from "minecraft-server-util";
import { serverConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

export const GET = async () => {
  try {
    const result = await status(serverConfig.queryHost, serverConfig.queryPort, {
      timeout: 3000,
      enableSRV: false,
    });
    return NextResponse.json({
      online: true,
      version: result.version?.name ?? null,
      motd:
        typeof result.motd === "string"
          ? result.motd
          : result.motd?.clean ?? null,
      players: {
        online: result.players?.online ?? 0,
        max: result.players?.max ?? 0,
        sample: result.players?.sample ?? [],
      },
      ping: result.roundTripLatency ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Status unavailable";
    return NextResponse.json(
      {
        online: false,
        error: message,
      },
      { status: 503 },
    );
  }
};
