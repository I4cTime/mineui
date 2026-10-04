"use client";

import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, Search } from "lucide-react";
import { Input, Label, TextField } from "@heroui/react";

// Paths are relative and forward-slash (contract §3.7).

interface FolderNode {
  /** Row label: one segment, or several joined by "/" after compression. */
  label: string;
  /** Full path of the (deepest, after compression) folder. */
  path: string;
  folders: FolderNode[];
  files: string[];
  count: number;
}

interface RawNode {
  folders: Map<string, RawNode>;
  files: string[];
}

function buildTree(files: string[]): { rootFiles: string[]; folders: FolderNode[] } {
  const root: RawNode = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part);
      if (!next) {
        next = { folders: new Map(), files: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }

  const count = (node: RawNode): number =>
    node.files.length + [...node.folders.values()].reduce((sum, n) => sum + count(n), 0);

  const convert = (name: string, parentPath: string, raw: RawNode): FolderNode => {
    let label = name;
    let path = parentPath ? `${parentPath}/${name}` : name;
    // A folder with one subfolder and no files of its own folds into one row.
    while (raw.files.length === 0 && raw.folders.size === 1) {
      const [childName, child] = [...raw.folders.entries()][0];
      label = `${label}/${childName}`;
      path = `${path}/${childName}`;
      raw = child;
    }
    return {
      label,
      path,
      folders: sortedFolders(raw, path),
      files: [...raw.files].sort(byName),
      count: count(raw),
    };
  };

  const sortedFolders = (raw: RawNode, parentPath: string): FolderNode[] =>
    [...raw.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]) => convert(name, parentPath, child));

  return {
    rootFiles: [...root.files].sort(byName),
    folders: sortedFolders(root, ""),
  };
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const byName = (a: string, b: string) => baseName(a).localeCompare(baseName(b));

/** Let long names break after a separator instead of mid-word: a
 *  `<wbr>` after each `_`, `.`, `/` and `-` (the text itself is unchanged). */
const soft = (text: string): React.ReactNode =>
  text.split(/(?<=[_./-])/).map((piece, index) => (
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {piece}
    </Fragment>
  ));

/** Wrap each case-insensitive occurrence of `needle` in a highlight. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{soft(text)}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let at = lower.indexOf(needle, from);
  while (at !== -1) {
    if (at > from) parts.push(<Fragment key={`t${from}`}>{soft(text.slice(from, at))}</Fragment>);
    parts.push(
      <mark key={at} className="rounded-sm bg-accent/25 text-foreground">
        {soft(text.slice(at, at + needle.length))}
      </mark>,
    );
    from = at + needle.length;
    at = lower.indexOf(needle, from);
  }
  if (from < text.length) parts.push(<Fragment key="tail">{soft(text.slice(from))}</Fragment>);
  return <>{parts}</>;
}

interface ConfigFileTreeProps {
  files: string[];
  selected: string | null;
  /** The open file has unsaved edits. */
  dirty: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onSelect: (file: string) => void;
}

const ROW =
  "flex w-full items-start gap-1.5 rounded-md py-1 pr-2 text-left text-sm hover:bg-default focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

export default function ConfigFileTree({
  files,
  selected,
  dirty,
  query,
  onQueryChange,
  onSelect,
}: ConfigFileTreeProps) {
  const needle = query.toLowerCase().trim();
  const shown = useMemo(
    () => (needle ? files.filter((f) => f.toLowerCase().includes(needle)) : files),
    [files, needle],
  );
  const tree = useMemo(() => buildTree(shown), [shown]);

  // User's explicit open/closed choices. Without one, a folder is open when
  // it holds the selected file; while searching everything is open.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const isOpen = useCallback(
    (path: string) => {
      if (needle) return true;
      if (path in overrides) return overrides[path];
      return selected !== null && selected.startsWith(`${path}/`);
    },
    [needle, overrides, selected],
  );

  // Visible rows in order, for the roving tabindex and arrow keys.
  const visibleKeys = useMemo(() => {
    const keys: string[] = [...tree.rootFiles.map((f) => `f:${f}`)];
    const walk = (folders: FolderNode[]) => {
      for (const folder of folders) {
        keys.push(`d:${folder.path}`);
        if (isOpen(folder.path)) {
          walk(folder.folders);
          keys.push(...folder.files.map((f) => `f:${f}`));
        }
      }
    };
    walk(tree.folders);
    return keys;
  }, [tree, isOpen]);

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const activeKey =
    focusKey && visibleKeys.includes(focusKey)
      ? focusKey
      : selected && visibleKeys.includes(`f:${selected}`)
        ? `f:${selected}`
        : (visibleKeys[0] ?? null);

  const listRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") {
      return;
    }
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-tree-key]") ?? []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next = at;
    if (event.key === "ArrowDown") next = Math.min(items.length - 1, at + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, at - 1);
    else if (event.key === "Home") next = 0;
    else next = items.length - 1;
    event.preventDefault();
    items[next]?.focus();
  };

  const toggle = (path: string) => {
    if (needle) return;
    setOverrides((prev) => ({ ...prev, [path]: !isOpen(path) }));
  };

  const fileRow = (file: string, depth: number) => {
    const key = `f:${file}`;
    const isSelected = file === selected;
    return (
      <button
        key={key}
        type="button"
        data-tree-key={key}
        tabIndex={activeKey === key ? 0 : -1}
        aria-current={isSelected ? "true" : undefined}
        title={file}
        onFocus={() => setFocusKey(key)}
        onClick={() => onSelect(file)}
        className={`${ROW} ${isSelected ? "bg-accent/15 font-medium text-accent" : "text-foreground"}`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <FileText size={14} className={`mt-0.5 shrink-0 ${isSelected ? "" : "text-muted"}`} aria-hidden />
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <Highlight text={baseName(file)} needle={needle} />
        </span>
        {isSelected && dirty && (
          <span className="mt-1.5 flex shrink-0 items-center" title="Unsaved changes">
            <span aria-hidden className="size-2 rounded-full bg-warning" />
            <span className="sr-only">edited</span>
          </span>
        )}
      </button>
    );
  };

  const folderRow = (folder: FolderNode, depth: number) => {
    const key = `d:${folder.path}`;
    const open = isOpen(folder.path);
    return (
      <Fragment key={key}>
        <button
          type="button"
          data-tree-key={key}
          tabIndex={activeKey === key ? 0 : -1}
          aria-expanded={open}
          title={folder.path}
          onFocus={() => setFocusKey(key)}
          onClick={() => toggle(folder.path)}
          className={`${ROW} text-foreground`}
          style={{ paddingLeft: 4 + depth * 14 }}
        >
          <ChevronRight
            size={14}
            aria-hidden
            className={`mt-0.5 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
          {open ? (
            <FolderOpen size={14} aria-hidden className="mt-0.5 shrink-0 text-accent" />
          ) : (
            <Folder size={14} aria-hidden className="mt-0.5 shrink-0 text-accent" />
          )}
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <Highlight text={folder.label} needle={needle} />
          </span>
          <span className="shrink-0 text-xs text-muted">
            {folder.count}
            <span className="sr-only"> files</span>
          </span>
        </button>
        {open && (
          <>
            {folder.folders.map((child) => folderRow(child, depth + 1))}
            {folder.files.map((file) => fileRow(file, depth + 1))}
          </>
        )}
      </Fragment>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-center gap-2">
        <Search size={16} className="shrink-0 text-muted" aria-hidden />
        <TextField className="w-full">
          <Label className="sr-only">Search files</Label>
          <Input
            placeholder="Search files"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </TextField>
      </div>
      {needle && (
        <span className="text-xs text-muted" aria-live="polite">
          {shown.length} of {files.length} files
        </span>
      )}
      <div
        ref={listRef}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden text-sm"
      >
        {shown.length ? (
          <div className="flex flex-col gap-0.5">
            {tree.rootFiles.length > 0 && (
              <>
                <span className="px-2 pt-1 pb-0.5 text-xs font-medium uppercase tracking-wide text-muted">
                  Server folder
                </span>
                {tree.rootFiles.map((file) => fileRow(file, 0))}
              </>
            )}
            {tree.folders.length > 0 && (
              <>
                {tree.rootFiles.length > 0 && (
                  <span className="px-2 pt-3 pb-0.5 text-xs font-medium uppercase tracking-wide text-muted">
                    Folders
                  </span>
                )}
                {tree.folders.map((folder) => folderRow(folder, 0))}
              </>
            )}
          </div>
        ) : (
          <span className="text-muted">
            {files.length
              ? `No files match “${query.trim()}”.`
              : "No config files yet - start the server once to create them."}
          </span>
        )}
      </div>
      <span className="text-xs text-muted">
        Shows server.properties and the text files in the server&apos;s config folder.
        Other files are not editable here.
      </span>
    </div>
  );
}
