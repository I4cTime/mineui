import { NextResponse } from "next/server";
import { runRcon } from "@/app/api/_utils/rcon";
import { getServerConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

const normalizeCommand = (value: string) => value.trim().replace(/^\//, "");

const isAllowed = (command: string, allowlist: string[]) => {
  const name = command.split(/\s+/)[0]?.toLowerCase();
  if (!name) return false;
  return allowlist.includes(name);
};

export const POST = async (request: Request) => {
  const body = await request.json().catch(() => ({}));
  const rawCommand = typeof body.command === "string" ? body.command : "";
  const command = normalizeCommand(rawCommand);
  const config = await getServerConfig();

  if (!command) {
    return NextResponse.json(
      { ok: false, error: "Command is required." },
      { status: 400 },
    );
  }

  if (command.length > 200) {
    return NextResponse.json(
      { ok: false, error: "Command too long." },
      { status: 400 },
    );
  }

  if (!isAllowed(command, config.rconAllowlist)) {
    return NextResponse.json(
      {
        ok: false,
        error: "Command not allowed by RCON allowlist.",
        allowlist: config.rconAllowlist,
      },
      { status: 403 },
    );
  }

  try {
    const output = await runRcon(command);
    return NextResponse.json({ ok: true, output });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "RCON command failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
