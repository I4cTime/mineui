// Shared display formatters. Timestamps arrive as epoch ms or RFC 3339
// strings per docs/v2-contract.md §7 — format client-side, "—" for unknown.

export const formatBytes = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

export const formatDateTime = (
  value: number | string | null | undefined,
): string => {
  if (value === null || value === undefined || value === 0 || value === "") {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};
