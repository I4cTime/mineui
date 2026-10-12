"use client";

import { Fragment, useCallback, useMemo, useState } from "react";
import type { Key, Selection } from "react-aria-components";
import { FileText, Folder, FolderOpen, Search } from "lucide-react";
import { Input, Label, TextField } from "@heroui/react";
import { FileTree } from "@heroui-pro/react";
import { firstKey } from "@/app/lib/keys";

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

  const folderPaths = useMemo(() => {
    const paths: string[] = [];
    const walk = (folders: FolderNode[]) => {
      for (const folder of folders) {
        paths.push(folder.path);
        walk(folder.folders);
      }
    };
    walk(tree.folders);
    return paths;
  }, [tree]);

  const expandedKeys = useMemo(
    () => new Set(folderPaths.filter(isOpen).map((path) => `d:${path}`)),
    [folderPaths, isOpen],
  );

  const setExpanded = (keys: Set<Key>) => {
    if (needle) return;
    setOverrides((prev) => {
      const next = { ...prev };
      for (const path of folderPaths) next[path] = keys.has(`d:${path}`);
      return next;
    });
  };

  // Folders toggle; files open in the editor. The selection itself stays
  // controlled by `selected`, so a folder press never moves it.
  const onSelectionChange = (keys: Selection) => {
    const key = firstKey(keys);
    if (!key) return;
    if (key.startsWith("f:")) onSelect(key.slice(2));
    else if (key.startsWith("d:") && !needle) {
      const path = key.slice(2);
      setOverrides((prev) => ({ ...prev, [path]: !isOpen(path) }));
    }
  };

  const fileItem = (file: string) => {
    const isSelected = file === selected;
    return (
      <FileTree.Item
        key={`f:${file}`}
        id={`f:${file}`}
        textValue={baseName(file)}
        icon={<FileText size={14} aria-hidden />}
        title={
          <span className="flex min-w-0 items-start gap-1.5" title={file}>
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <Highlight text={baseName(file)} needle={needle} />
            </span>
            {isSelected && dirty && (
              <span className="mt-1.5 flex shrink-0 items-center" title="Unsaved changes">
                <span aria-hidden className="size-2 rounded-full bg-warning" />
                <span className="sr-only">edited</span>
              </span>
            )}
          </span>
        }
      />
    );
  };

  const folderItem = (folder: FolderNode): React.ReactElement => (
    <FileTree.Item
      key={`d:${folder.path}`}
      id={`d:${folder.path}`}
      textValue={folder.label}
      icon={({ isExpanded }: { isExpanded: boolean }) =>
        isExpanded ? (
          <FolderOpen size={14} aria-hidden className="text-accent" />
        ) : (
          <Folder size={14} aria-hidden className="text-accent" />
        )
      }
      title={
        <span className="flex min-w-0 items-start gap-1.5" title={folder.path}>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <Highlight text={folder.label} needle={needle} />
          </span>
          <span className="shrink-0 text-xs text-muted">
            {folder.count}
            <span className="sr-only"> files</span>
          </span>
        </span>
      }
    >
      {folder.folders.map(folderItem)}
      {folder.files.map(fileItem)}
    </FileTree.Item>
  );

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
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden text-sm">
        {shown.length ? (
          <FileTree
            aria-label="Config files"
            size="sm"
            showGuideLines="hover"
            selectionMode="single"
            selectedKeys={selected ? [`f:${selected}`] : []}
            onSelectionChange={onSelectionChange}
            expandedKeys={expandedKeys}
            onExpandedChange={setExpanded}
          >
            {tree.rootFiles.length > 0 && (
              <FileTree.Section>
                <FileTree.Header>Server folder</FileTree.Header>
                {tree.rootFiles.map(fileItem)}
              </FileTree.Section>
            )}
            {tree.folders.length > 0 && (
              <FileTree.Section>
                {tree.rootFiles.length > 0 && <FileTree.Header>Folders</FileTree.Header>}
                {tree.folders.map(folderItem)}
              </FileTree.Section>
            )}
          </FileTree>
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
