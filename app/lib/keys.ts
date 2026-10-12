// Selection callbacks hand back either one key or a Set of keys depending on
// the component (React Aria ToggleButtonGroup vs. single-select wrappers).
// Normalize to the first selected key as a string, or null when none is.
export function firstKey(selection: unknown): string | null {
  if (selection instanceof Set) {
    const [first] = selection;
    return first === undefined ? null : String(first);
  }
  if (selection === null || selection === undefined) return null;
  return String(selection);
}
