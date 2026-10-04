"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCcw, RotateCcw, Save } from "lucide-react";
import { Alert, Button, Label, Switch } from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";

const WRAP_KEY = "mineui-config-wrap";

function readWrap(): boolean {
  try {
    return window.localStorage.getItem(WRAP_KEY) === "1";
  } catch {
    return false;
  }
}

function countLines(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
}

/** Line numbers as one text block, so a few thousand lines stay one node.
 *  Re-renders only when the line count changes. */
const Gutter = memo(function Gutter({
  lines,
  gutterRef,
}: {
  lines: number;
  gutterRef: React.RefObject<HTMLDivElement | null>;
}) {
  const text = useMemo(() => {
    const out: string[] = new Array(lines);
    for (let i = 0; i < lines; i++) out[i] = String(i + 1);
    return out.join("\n");
  }, [lines]);
  const digits = String(lines).length;
  return (
    <div
      ref={gutterRef}
      aria-hidden
      data-testid="config-gutter"
      className="shrink-0 select-none overflow-hidden border-r border-field-border bg-default/40 text-right font-mono text-xs leading-5 text-muted"
      style={{ width: `calc(${digits}ch + 1.5rem)` }}
    >
      {/* The bottom padding covers the textarea's horizontal scrollbar so the
          gutter can scroll as far as the text does. */}
      <div className="whitespace-pre px-3 pt-3 pb-8">{text}</div>
    </div>
  );
});

interface ConfigEditorProps {
  selected: string | null;
  content: string;
  onContentChange: (value: string) => void;
  /** The text shown really is `selected`'s. */
  ready: boolean;
  dirty: boolean;
  saving: boolean;
  restarting: boolean;
  running: boolean;
  fileError: string | null;
  onSave: () => void;
  onRevert: () => void;
  onRestart: () => void;
  onRetry: () => void;
}

export default function ConfigEditor({
  selected,
  content,
  onContentChange,
  ready,
  dirty,
  saving,
  restarting,
  running,
  fileError,
  onSave,
  onRevert,
  onRestart,
  onRetry,
}: ConfigEditorProps) {
  const { play } = useUISound();
  const [wrap, setWrap] = useState(readWrap);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => countLines(content), [content]);

  const folder = selected && selected.includes("/") ? selected.slice(0, selected.lastIndexOf("/")) : "";
  const name = selected ? selected.slice(selected.lastIndexOf("/") + 1) : "";

  // Ctrl+S / Cmd+S saves while this page is mounted.
  const saveRef = useRef({ dirty, saving, onSave });
  useEffect(() => {
    saveRef.current = { dirty, saving, onSave };
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      const current = saveRef.current;
      if (current.dirty && !current.saving) current.onSave();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const syncScroll = () => {
    if (gutterRef.current && areaRef.current) {
      gutterRef.current.scrollTop = areaRef.current.scrollTop;
    }
  };

  // A new file or a revert changes the text under the scroll position.
  useEffect(() => {
    syncScroll();
  }, [selected, wrap, lines]);

  const updateCursor = () => {
    const area = areaRef.current;
    if (!area) return;
    const before = area.value.slice(0, area.selectionStart);
    const line = countLines(before);
    setCursor({ line, col: before.length - before.lastIndexOf("\n") });
  };

  const toggleWrap = (value: boolean) => {
    play(value ? "toggle_on" : "toggle_off");
    setWrap(value);
    try {
      window.localStorage.setItem(WRAP_KEY, value ? "1" : "0");
    } catch {
      // Not remembered; the toggle still works for this visit.
    }
  };

  const placeholder = !selected
    ? "Select a file to load its contents."
    : fileError
      ? ""
      : ready
        ? "This file is empty."
        : `Opening ${selected}…`;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="font-pixel text-sm tracking-wide text-accent [overflow-wrap:anywhere]">
              {selected ? name : "Select a file"}
            </h2>
            {dirty && (
              <span className="flex items-center gap-1.5 text-xs text-warning">
                <span aria-hidden className="size-2 rounded-full bg-warning" />
                Unsaved changes
              </span>
            )}
          </div>
          {selected && (
            <p className="mt-1 text-xs text-muted [overflow-wrap:anywhere]">
              {folder ? `in ${folder}/` : "in the server folder"}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onPress={onSave} isDisabled={saving || !dirty} onMouseEnter={() => play("hover")}>
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            variant="secondary"
            onPress={() => {
              play("click_back");
              onRevert();
            }}
            isDisabled={saving || !dirty}
            onMouseEnter={() => play("hover")}
          >
            <RotateCcw size={16} />
            Revert
          </Button>
          <Button
            variant="secondary"
            onPress={onRestart}
            isDisabled={restarting || !running}
            onMouseEnter={() => play("hover")}
          >
            <RefreshCcw size={16} />
            Restart to apply
          </Button>
        </div>
      </div>

      {fileError && selected && (
        <Alert
          status="danger"
          role="alert"
          className="flex-wrap items-center justify-between gap-3 rounded-lg border border-danger bg-transparent p-3 shadow-none"
        >
          <Alert.Indicator className="p-0 text-danger" />
          <Alert.Content className="min-w-0 flex-1">
            <Alert.Description className="text-sm text-foreground [overflow-wrap:anywhere]">
              Could not open {selected}: {fileError}
            </Alert.Description>
          </Alert.Content>
          <Button size="sm" variant="secondary" onPress={onRetry}>
            Try again
          </Button>
        </Alert>
      )}

      <div className="flex min-h-[260px] flex-1 overflow-hidden rounded-lg border border-field-border bg-field focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-accent">
        {!wrap && <Gutter lines={lines} gutterRef={gutterRef} />}
        <textarea
          ref={areaRef}
          aria-label={selected ? `Contents of ${selected}` : "File contents"}
          wrap={wrap ? "soft" : "off"}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className={`min-w-0 flex-1 resize-none bg-transparent px-3 py-3 font-mono text-xs leading-5 text-foreground outline-none disabled:opacity-60 ${
            wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "overflow-x-auto whitespace-pre"
          }`}
          value={content}
          disabled={!ready}
          onChange={(event) => {
            onContentChange(event.target.value);
            updateCursor();
          }}
          onScroll={syncScroll}
          onKeyUp={updateCursor}
          onClick={updateCursor}
          onSelect={updateCursor}
          placeholder={placeholder}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted">
        <span>
          {ready ? (
            <>
              {lines} {lines === 1 ? "line" : "lines"}
              {" · "}Line {cursor.line}, column {cursor.col}
            </>
          ) : (
            " "
          )}
        </span>
        <Switch isSelected={wrap} onChange={toggleWrap}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>Wrap lines</Label>
          </Switch.Content>
        </Switch>
      </div>
    </div>
  );
}
