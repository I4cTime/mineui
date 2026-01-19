import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serverConfig } from "@/app/lib/serverConfig";

const execFileAsync = promisify(execFile);
const PODMAN_BIN = process.env.PODMAN_BINARY ?? "podman";

const getPodmanEnv = () => {
  const socket = serverConfig.podmanSocket;
  const host = socket.startsWith("unix://") ? socket : `unix://${socket}`;
  return {
    ...process.env,
    CONTAINER_HOST: host,
  };
};

export const runPodman = async (args: string[]) => {
  const { stdout, stderr } = await execFileAsync(PODMAN_BIN, args, {
    env: getPodmanEnv(),
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
};

export type ContainerState = {
  exists: boolean;
  running: boolean;
  status: string | null;
  id: string | null;
  createdAt: string | null;
};

export const getContainerState = async (
  name: string,
): Promise<ContainerState> => {
  try {
    const { stdout } = await runPodman([
      "ps",
      "--all",
      "--filter",
      `name=^${name}$`,
      "--format",
      "json",
    ]);
    if (!stdout) {
      return {
        exists: false,
        running: false,
        status: null,
        id: null,
        createdAt: null,
      };
    }
    const parsed = JSON.parse(stdout);
    const container = Array.isArray(parsed) ? parsed[0] : null;
    if (!container) {
      return {
        exists: false,
        running: false,
        status: null,
        id: null,
        createdAt: null,
      };
    }
    const status = container?.State ?? container?.Status ?? null;
    return {
      exists: true,
      running: status === "running" || status === "Running",
      status,
      id: container?.Id ?? null,
      createdAt: container?.CreatedAt ?? null,
    };
  } catch {
    return {
      exists: false,
      running: false,
      status: null,
      id: null,
      createdAt: null,
    };
  }
};

export const safeList = (value: string) => {
  if (!value) return [];
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
};
