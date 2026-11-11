"use client";

// A word with a "What's this?" explanation. Click, tap, Enter or Space opens
// a small popover; Escape closes it. Tokens only, so it follows every style
// and light/dark.
import { Popover } from "@heroui/react";
import { Pressable } from "react-aria-components";
import { GLOSSARY, type GlossaryTerm } from "@/app/lib/glossary";

export default function Term({
  term,
  children,
}: {
  term: GlossaryTerm;
  /** What to show in the text; defaults to the term itself. */
  children?: React.ReactNode;
}) {
  const entry = GLOSSARY[term];
  return (
    <Popover>
      {/* A <span>, not Popover.Trigger: that renders a <div>, which is not
          allowed inside the <p> most Terms sit in. Pressable gives the span
          the same press handling (click, tap, Enter, Space). */}
      <Pressable>
        <span
          role="button"
          tabIndex={0}
          aria-label={`What's this? ${entry.title}`}
          data-term={term}
          className="cursor-help rounded-sm underline decoration-dotted decoration-muted underline-offset-4 outline-none hover:decoration-accent focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ outlineColor: "var(--focus)" }}
        >
          {children ?? term}
          <span
            aria-hidden
            className="ms-0.5 align-super text-[0.65em] font-semibold text-muted"
          >
            ?
          </span>
        </span>
      </Pressable>
      <Popover.Content className="max-w-72" placement="bottom">
        <Popover.Dialog>
          <Popover.Heading className="text-sm font-semibold">
            {entry.title}
          </Popover.Heading>
          <p className="mt-1 text-sm text-muted">{entry.body}</p>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
