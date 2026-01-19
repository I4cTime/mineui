const getEnv = (key: string, fallback: string) => {
  return process.env[key] ?? fallback;
};

export const serverConfig = {
  containerName: getEnv("MINECRAFT_CONTAINER_NAME", "minecraft-server"),
  queryHost: getEnv("MINECRAFT_QUERY_HOST", "127.0.0.1"),
  queryPort: Number(getEnv("MINECRAFT_QUERY_PORT", "25565")),
  podmanSocket: getEnv("PODMAN_SOCKET", "/run/user/1000/podman/podman.sock"),
  worldDir: getEnv("MINECRAFT_WORLD_DIR", "world"),
  rconHost: getEnv("MINECRAFT_RCON_HOST", "127.0.0.1"),
  rconPort: Number(getEnv("MINECRAFT_RCON_PORT", "25575")),
  rconPassword: getEnv("MINECRAFT_RCON_PASSWORD", ""),
  rconAllowlist: getEnv(
    "MINECRAFT_RCON_ALLOWLIST",
    "list,whitelist,op,deop,ban,pardon,banlist,kick,say,save-all,stop,tps",
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
};
