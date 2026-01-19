import { NextResponse } from "next/server";
import { runPodman } from "@/app/api/_utils/podman";
import { serverConfig } from "@/app/lib/serverConfig";

const getTimestamp = () => {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

export const POST = async () => {
  const filename = `world-${getTimestamp()}.tar.gz`;
  try {
    await runPodman([
      "exec",
      serverConfig.containerName,
      "sh",
      "-c",
      "mkdir -p /data/backups",
    ]);
    await runPodman([
      "exec",
      serverConfig.containerName,
      "sh",
      "-c",
      `tar -czf /data/backups/${filename} -C /data ${serverConfig.worldDir}`,
    ]);
    return NextResponse.json({ ok: true, filename });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backup failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
