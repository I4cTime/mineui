"use client";

// App-wide view level: "simple" shows what you need to run a server with
// friends, "advanced" shows everything. This is a VIEW setting only - it is
// kept in localStorage on this machine and never calls any IPC, never
// changes a server or a setting. (The 2.9.0 header toggle switched a server
// between "On this computer" and "In a container" and looked like deleting
// it; the server's run kind still lives in Server Settings > Advanced.)
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";

export type ViewLevel = "simple" | "advanced";

export const VIEW_LEVEL_KEY = "mineui-view-level";
export const DEFAULT_VIEW_LEVEL: ViewLevel = "simple";

export const VIEW_LEVELS: { id: ViewLevel; label: string }[] = [
  { id: "simple", label: "Simple" },
  { id: "advanced", label: "Advanced" },
];

export const VIEW_LEVEL_HINT =
  "Simple shows what you need to run a server with friends. Advanced shows everything.";

const isLevel = (value: unknown): value is ViewLevel =>
  value === "simple" || value === "advanced";

let cached: ViewLevel | undefined;
const listeners = new Set<() => void>();

function readStored(): ViewLevel {
  if (cached !== undefined) return cached;
  let level: ViewLevel = DEFAULT_VIEW_LEVEL;
  try {
    const stored = window.localStorage.getItem(VIEW_LEVEL_KEY);
    if (isLevel(stored)) level = stored;
  } catch {
    // No storage (private window, blocked): the default holds.
  }
  cached = level;
  return level;
}

function writeStored(level: ViewLevel) {
  cached = level;
  try {
    window.localStorage.setItem(VIEW_LEVEL_KEY, level);
  } catch {
    // Not remembered, still applied for this session.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

interface ViewLevelContextValue {
  level: ViewLevel;
  setLevel: (level: ViewLevel) => void;
}

const ViewLevelContext = createContext<ViewLevelContextValue | null>(null);

export default function ViewLevelProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const level = useSyncExternalStore(
    subscribe,
    readStored,
    () => DEFAULT_VIEW_LEVEL,
  );
  const setLevel = useCallback((next: ViewLevel) => writeStored(next), []);
  const value = useMemo(() => ({ level, setLevel }), [level, setLevel]);
  return (
    <ViewLevelContext.Provider value={value}>
      {children}
    </ViewLevelContext.Provider>
  );
}

export function useViewLevel(): ViewLevelContextValue {
  const ctx = useContext(ViewLevelContext);
  if (!ctx) {
    throw new Error("useViewLevel() must be used within a <ViewLevelProvider>");
  }
  return ctx;
}
