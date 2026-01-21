import { NextResponse } from "next/server";
import { runPodman } from "@/app/api/_utils/podman";
import { getServerConfig } from "@/app/lib/serverConfig";

const getTimestamp = () => {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

export const POST = async () => {
  const config = await getServerConfig();
  const filename = `world-${getTimestamp()}.tar.gz`;
  try {
    await runPodman([
      "exec",
      config.containerName,
      "sh",
      "-c",
      "mkdir -p /data/backups",
    ]);
    await runPodman([
      "exec",
      config.containerName,
      "sh",
      "-c",
      `tar -czf /data/backups/${filename} -C /data ${config.worldDir}`,
    ]);
    return NextResponse.json({ ok: true, filename });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backup failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
