import { Rcon } from "rcon-client";
import { serverConfig } from "@/app/lib/serverConfig";

export const runRcon = async (command: string) => {
  if (!serverConfig.rconPassword) {
    throw new Error("RCON password not configured");
  }
  const rcon = await Rcon.connect({
    host: serverConfig.rconHost,
    port: serverConfig.rconPort,
    password: serverConfig.rconPassword,
  });
  try {
    return await rcon.send(command);
  } finally {
    await rcon.end();
  }
};
