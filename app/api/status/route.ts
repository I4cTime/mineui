import { NextResponse } from "next/server";
import { status } from "minecraft-server-util";
import {
  fetchServerUtilsJson,
  getServerUtilsBaseUrl,
} from "@/app/api/_utils/mineuiServerUtils";
import { getServerConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

type ServerUtilsStatus = {
  ok: boolean;
  properties?: Record<string, string>;
  players?: string[];
  errors?: string[];
};

type ServerUtilsMetrics = {
  ok: boolean;
  players?: { online?: number; max?: number };
};

type ServerUtilsMods = {
  ok: boolean;
  mods: Array<{ id: string; name: string; version: string }>;
};

const parseMaxPlayers = (value?: string) => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const GET = async () => {
  const serverUtilsUrl = await getServerUtilsBaseUrl();
  if (serverUtilsUrl) {
    const [statusRes, metricsRes, modsRes] = await Promise.allSettled([
      fetchServerUtilsJson<ServerUtilsStatus>("/status"),
      fetchServerUtilsJson<ServerUtilsMetrics>("/metrics"),
      fetchServerUtilsJson<ServerUtilsMods>("/mods"),
    ]);

    if (statusRes.status === "fulfilled") {
      const payload = statusRes.value;
      const properties = payload.properties ?? {};
      const playersList = payload.players ?? [];

      let online = payload.ok;
      let onlinePlayers = playersList.length;
      let maxPlayers =
        parseMaxPlayers(properties["max-players"]) ??
        parseMaxPlayers(properties["max_players"]) ??
        null;

      if (metricsRes.status === "fulfilled" && metricsRes.value.ok) {
        onlinePlayers =
          metricsRes.value.players?.online ?? onlinePlayers;
        maxPlayers =
          metricsRes.value.players?.max ?? maxPlayers;
      }

      let version: string | null = null;
      if (modsRes.status === "fulfilled" && modsRes.value.ok) {
        const minecraftMod = modsRes.value.mods.find(
          (mod) => mod.id === "minecraft" || mod.name === "Minecraft",
        );
        version = minecraftMod?.version ?? null;
      }

      return NextResponse.json({
        online,
        version,
        motd: properties.motd ?? null,
        players: {
          online: onlinePlayers,
          max: maxPlayers ?? 0,
          sample: playersList.map((name) => ({ name })),
        },
        ping: null,
        error: payload.ok ? undefined : payload.errors?.[0],
      });
    }
  }

  try {
    const config = await getServerConfig();
    const result = await status(config.queryHost, config.queryPort, {
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
