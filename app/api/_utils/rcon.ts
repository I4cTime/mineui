import { Rcon } from "rcon-client";
import { getServerConfig } from "@/app/lib/serverConfig";

export const runRcon = async (command: string) => {
  const config = await getServerConfig();
  if (!config.rconPassword) {
    throw new Error("RCON password not configured");
  }
  const rcon = await Rcon.connect({
    host: config.rconHost,
    port: config.rconPort,
    password: config.rconPassword,
  });
  try {
    return await rcon.send(command);
  } finally {
    await rcon.end();
  }
};
