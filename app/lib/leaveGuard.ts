// Unsaved-work guard for in-app navigation (UX review 2026-10): a page with
// unsaved edits registers how to ask; the header navigation and the server
// switch route through `leaveOr`, so edits are never dropped silently.
// One guard at a time - the page that is on screen.
type Ask = (proceed: () => void) => void;

let ask: Ask | null = null;

/** Register (or with `null`, clear) the current page's "ask before leaving". */
export function setLeaveGuard(next: Ask | null) {
  ask = next;
}

/** Run `proceed` now, or hand it to the page with unsaved work to confirm. */
export function leaveOr(proceed: () => void) {
  if (ask) ask(proceed);
  else proceed();
}
