import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

export const revalidate = 0;

const settingsPath = () =>
  path.join(process.cwd(), ".cursor", "mineui-settings.json");

const allowedKeys = new Set([
  "MINECRAFT_CONTAINER_NAME",
  "MINECRAFT_QUERY_HOST",
  "MINECRAFT_QUERY_PORT",
  "PODMAN_SOCKET",
  "PODMAN_BINARY",
  "MINECRAFT_WORLD_DIR",
  "MINECRAFT_RCON_HOST",
  "MINECRAFT_RCON_PORT",
  "MINECRAFT_RCON_PASSWORD",
  "MINECRAFT_RCON_ALLOWLIST",
  "MINEUI_SERVER_UTILS_URL",
]);

const sanitizeSettings = (payload: Record<string, unknown>) => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!allowedKeys.has(key)) continue;
    if (value === null || value === undefined) continue;
    result[key] = String(value);
  }
  return result;
};

export const GET = async () => {
  try {
    const raw = await fs.readFile(settingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    return NextResponse.json({ ok: true, settings: parsed });
  } catch {
    return NextResponse.json({ ok: true, settings: {} });
  }
};

export const POST = async (request: Request) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const sanitized = sanitizeSettings(body);
    await fs.mkdir(path.join(process.cwd(), ".cursor"), { recursive: true });
    await fs.writeFile(
      settingsPath(),
      JSON.stringify(sanitized, null, 2),
      "utf-8",
    );
    return NextResponse.json({ ok: true, settings: sanitized });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save settings";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
