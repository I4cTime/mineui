import { promises as fs } from "node:fs";
import path from "node:path";

const getEnv = (key: string, fallback: string) => {
  return process.env[key] ?? fallback;
};

export type ServerConfig = {
  containerName: string;
  queryHost: string;
  queryPort: number;
  podmanSocket: string;
  podmanBinary: string;
  worldDir: string;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  mineuiServerUtilsUrl: string;
  rconAllowlist: string[];
};

export const serverConfig: ServerConfig = {
  containerName: getEnv("MINECRAFT_CONTAINER_NAME", "minecraft-server"),
  queryHost: getEnv("MINECRAFT_QUERY_HOST", "127.0.0.1"),
  queryPort: Number(getEnv("MINECRAFT_QUERY_PORT", "25565")),
  podmanSocket: getEnv("PODMAN_SOCKET", "/run/user/1000/podman/podman.sock"),
  podmanBinary: getEnv("PODMAN_BINARY", "podman"),
  worldDir: getEnv("MINECRAFT_WORLD_DIR", "world"),
  rconHost: getEnv("MINECRAFT_RCON_HOST", "127.0.0.1"),
  rconPort: Number(getEnv("MINECRAFT_RCON_PORT", "25575")),
  rconPassword: getEnv("MINECRAFT_RCON_PASSWORD", ""),
  mineuiServerUtilsUrl: getEnv("MINEUI_SERVER_UTILS_URL", ""),
  rconAllowlist: getEnv(
    "MINECRAFT_RCON_ALLOWLIST",
    "list,whitelist,op,deop,ban,pardon,banlist,kick,say,save-all,stop,tps",
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
};

type SettingsOverrides = Partial<{
  MINECRAFT_CONTAINER_NAME: string;
  MINECRAFT_QUERY_HOST: string;
  MINECRAFT_QUERY_PORT: number | string;
  PODMAN_SOCKET: string;
  PODMAN_BINARY: string;
  MINECRAFT_WORLD_DIR: string;
  MINECRAFT_RCON_HOST: string;
  MINECRAFT_RCON_PORT: number | string;
  MINECRAFT_RCON_PASSWORD: string;
  MINECRAFT_RCON_ALLOWLIST: string;
  MINEUI_SERVER_UTILS_URL: string;
}>;

const settingsPath = () =>
  path.join(process.cwd(), ".cursor", "mineui-settings.json");

const normalizeConfig = (overrides: SettingsOverrides | null): ServerConfig => {
  if (!overrides) return serverConfig;
  const toNumber = (value: number | string | undefined, fallback: number) => {
    if (value === undefined || value === null || value === "") return fallback;
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
  };
  const allowlist =
    overrides.MINECRAFT_RCON_ALLOWLIST ?? serverConfig.rconAllowlist.join(",");
  return {
    containerName:
      overrides.MINECRAFT_CONTAINER_NAME ?? serverConfig.containerName,
    queryHost: overrides.MINECRAFT_QUERY_HOST ?? serverConfig.queryHost,
    queryPort: toNumber(overrides.MINECRAFT_QUERY_PORT, serverConfig.queryPort),
    podmanSocket: overrides.PODMAN_SOCKET ?? serverConfig.podmanSocket,
    podmanBinary: overrides.PODMAN_BINARY ?? serverConfig.podmanBinary,
    worldDir: overrides.MINECRAFT_WORLD_DIR ?? serverConfig.worldDir,
    rconHost: overrides.MINECRAFT_RCON_HOST ?? serverConfig.rconHost,
    rconPort: toNumber(overrides.MINECRAFT_RCON_PORT, serverConfig.rconPort),
    rconPassword:
      overrides.MINECRAFT_RCON_PASSWORD ?? serverConfig.rconPassword,
    mineuiServerUtilsUrl:
      overrides.MINEUI_SERVER_UTILS_URL ?? serverConfig.mineuiServerUtilsUrl,
    rconAllowlist: allowlist
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
};

export const getServerConfig = async (): Promise<ServerConfig> => {
  try {
    const raw = await fs.readFile(settingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as SettingsOverrides;
    return normalizeConfig(parsed);
  } catch {
    return serverConfig;
  }
};
