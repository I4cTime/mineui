// Small celebrations that must not repeat: which ones a server already had is
// kept in localStorage per server, so a reload never replays a sound or a
// banner. Storage can be missing or blocked, so every call is guarded.
import { toast } from "@heroui/react";

export const CELEBRATED_KEY = "mineui-getting-started-celebrated";

export type Milestone = "started" | "joined" | "friend" | "backup" | "all";

const key = (serverId: string) => `${CELEBRATED_KEY}:${serverId}`;

export function readCelebrated(serverId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key(serverId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function markCelebrated(serverId: string, id: Milestone) {
  try {
    const next = readCelebrated(serverId);
    next.add(id);
    window.localStorage.setItem(key(serverId), JSON.stringify([...next]));
  } catch {
    // Not remembered across restarts; the session still will not replay it.
  }
}

/** The "your server is made" toast (the caller plays the success sound). */
export function announceServerMade(detail: string) {
  toast.success("Your server is made!", { description: detail });
}

/** The "a friend joined" toast (the caller plays the success sound). */
export function announceFriendJoined() {
  toast.success("A friend joined!", {
    description: "Your server is not just yours anymore. Have fun.",
  });
}
