// A short in-memory history of live numbers per server, for the sparklines
// on Status and the dashboard. Samples come from polls those pages already
// make (no extra IPC); the history lives for this app session only and
// survives moving between pages.
import { useSyncExternalStore } from "react";

export type MetricSample = {
  at: number;
  cpu?: number | null;
  mem?: number | null;
  tps?: number | null;
  players?: number | null;
};

export type MetricKey = Exclude<keyof MetricSample, "at">;

/** Keep the last hour at the slowest (30s) poll. */
const MAX_SAMPLES = 120;

const store = new Map<string, MetricSample[]>();
const listeners = new Set<() => void>();
const EMPTY: MetricSample[] = [];

export function recordSample(serverId: string, sample: Omit<MetricSample, "at">) {
  const prev = store.get(serverId) ?? EMPTY;
  const next = [...prev, { at: Date.now(), ...sample }];
  store.set(serverId, next.length > MAX_SAMPLES ? next.slice(-MAX_SAMPLES) : next);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The samples of one server that carry `key`, oldest first. */
export function useMetricHistory(serverId: string): MetricSample[] {
  return useSyncExternalStore(
    subscribe,
    () => store.get(serverId) ?? EMPTY,
    () => EMPTY,
  );
}

export function seriesOf(samples: MetricSample[], key: MetricKey): { at: number; value: number }[] {
  const out: { at: number; value: number }[] = [];
  for (const sample of samples) {
    const value = sample[key];
    if (typeof value === "number" && Number.isFinite(value)) out.push({ at: sample.at, value });
  }
  return out;
}
