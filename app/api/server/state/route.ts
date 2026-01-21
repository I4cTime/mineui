import { NextResponse } from "next/server";
import { getContainerState } from "@/app/api/_utils/podman";
import { getServerConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

export const GET = async () => {
  const config = await getServerConfig();
  const state = await getContainerState(config.containerName);
  return NextResponse.json(state);
};
