import { NextResponse } from "next/server";
import { getContainerState } from "@/app/api/_utils/podman";
import { serverConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

export const GET = async () => {
  const state = await getContainerState(serverConfig.containerName);
  return NextResponse.json(state);
};
