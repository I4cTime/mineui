import { NextResponse } from "next/server";
import { runRcon } from "@/app/api/_utils/rcon";

export const revalidate = 0;

const parseList = (output: string) => {
  const parts = output.split(":");
  if (parts.length < 2) return [];
  return parts[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
};

export const GET = async () => {
  try {
    const listOutput = await runRcon("list");
    const players = parseList(listOutput);
    return NextResponse.json({
      ok: true,
      raw: {
        list: listOutput,
      },
      players,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "RCON unavailable";
    return NextResponse.json(
      { ok: false, error: message, players: [], raw: null },
      { status: 500 },
    );
  }
};
