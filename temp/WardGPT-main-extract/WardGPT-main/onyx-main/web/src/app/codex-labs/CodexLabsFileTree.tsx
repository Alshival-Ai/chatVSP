"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Text from "@/refresh-components/texts/Text";
import {
  SvgChevronDown,
  SvgChevronRight,
  SvgCopy,
  SvgDownloadCloud,
  SvgEye,
  SvgFileText,
  SvgFolder,
  SvgFolderOpen,
} from "@opal/icons";
import { type CodexLabsFileEntry } from "@/app/codex-labs/types";

interface ContextMenuState {
  entry: CodexLabsFileEntry | null;
  x: number;
  y: number;
}

const CONTEXT_MENU_MARGIN_PX = 8;
const SHOW_HIDDEN_STORAGE_KEY = "codex-labs-show-hidden-files-v1";

interface CodexLabsFileTreeProps {
  entriesByPath: Record<string, CodexLabsFileEntry[]>;
  expandedPaths: string[];
  loadingPaths: string[];
  selectedPath: string | null;
  onSelectEntry: (entry: CodexLabsFileEntry) => void;
  onToggleDirectory: (entry: CodexLabsFileEntry) => void;
  onActivateEntry: (entry: CodexLabsFileEntry) => void;
  onPreviewEntry: (entry: CodexLabsFileEntry) => void;
  onDownloadEntry: (entry: CodexLabsFileEntry) => void;
  onCopyPath: (entry: CodexLabsFileEntry) => void;
  onRenameEntry: (entry: CodexLabsFileEntry) => void;
  onDeleteEntry: (entry: CodexLabsFileEntry) => void;
  onMoveEntry: (entry: CodexLabsFileEntry, destinationPath: string) => void;
  onUploadFiles: (files: File[], destinationPath: string) => Promise<void> | void;
  canPreviewEntry: (entry: CodexLabsFileEntry) => boolean;
}

function getParentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function eventHasExternalFiles(event: ReactDragEvent<HTMLDivElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function isHiddenEntry(entry: CodexLabsFileEntry): boolean {
  return entry.name.startsWith(".");
}

function TreeRow({
  entry,
  depth,
  isExpanded,
  isSelected,
  isDropTarget,
  canPreview,
  draggedPath,
  onSelectEntry,
  onToggleDirectory,
  onActivateEntry,
  onOpenMenu,
  onDragStartEntry,
  onDragEndEntry,
  onDragOverDirectory,
  onDropDirectory,
}: {
  entry: CodexLabsFileEntry;
  depth: number;
  isExpanded: boolean;
  isSelected: boolean;
  isDropTarget: boolean;
  canPreview: boolean;
  draggedPath: string | null;
  onSelectEntry: (entry: CodexLabsFileEntry) => void;
  onToggleDirectory: (entry: CodexLabsFileEntry) => void;
  onActivateEntry: (entry: CodexLabsFileEntry) => void;
  onOpenMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    entry: CodexLabsFileEntry
  ) => void;
  onDragStartEntry: (entry: CodexLabsFileEntry) => void;
  onDragEndEntry: () => void;
  onDragOverDirectory: (
    event: ReactDragEvent<HTMLDivElement>,
    entry: CodexLabsFileEntry
  ) => void;
  onDropDirectory: (
    event: ReactDragEvent<HTMLDivElement>,
    entry: CodexLabsFileEntry
  ) => void;
}) {
  const handleClick = () => {
    onSelectEntry(entry);
    if (entry.is_directory) {
      onToggleDirectory(entry);
    }
  };

  const handleDoubleClick = () => {
    if (entry.is_directory) {
      return;
    }
    onActivateEntry(entry);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={`flex w-full items-center gap-2 rounded-08 px-2 py-1.5 text-left ${
        isDropTarget
          ? "bg-background-tint-02 ring-1 ring-border-04"
          : isSelected
          ? "bg-background-tint-03 text-text-00"
          : "hover:bg-background-neutral-01"
      }`}
      style={{ paddingLeft: `${depth * 0.875 + 0.5}rem` }}
      draggable={draggedPath !== entry.path}
      onDragStart={() => onDragStartEntry(entry)}
      onDragEnd={onDragEndEntry}
      onDragOver={(event) => onDragOverDirectory(event, entry)}
      onDrop={(event) => onDropDirectory(event, entry)}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(event) => onOpenMenu(event, entry)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (entry.is_directory) {
            onToggleDirectory(entry);
            return;
          }
          onActivateEntry(entry);
        }
      }}
      title={entry.name}
    >
      {entry.is_directory ? (
        <>
          {isExpanded ? (
            <SvgChevronDown className="h-4 w-4 shrink-0 stroke-text-03" />
          ) : (
            <SvgChevronRight className="h-4 w-4 shrink-0 stroke-text-03" />
          )}
          <span className="rounded-08 p-0.5">
            {isExpanded ? (
              <SvgFolderOpen className="h-4 w-4 shrink-0 stroke-text-03" />
            ) : (
              <SvgFolder className="h-4 w-4 shrink-0 stroke-text-03" />
            )}
          </span>
        </>
      ) : (
        <>
          <span className="w-4 shrink-0" />
          <SvgFileText className="h-4 w-4 shrink-0 stroke-text-03" />
        </>
      )}

      <div className="min-w-0 flex-1">
        <Text className="truncate">{entry.name}</Text>
      </div>

      {!entry.is_directory && canPreview ? (
        <span className="shrink-0 whitespace-nowrap rounded-full border border-border-02 bg-background-neutral-01 px-1.5 py-0.5 text-[10px] font-medium leading-none text-text-03">
          Preview
        </span>
      ) : null}
    </div>
  );
}

function FileTreeBranch({
  path,
  depth,
  entriesByPath,
  expandedPaths,
  loadingPaths,
  selectedPath,
  dropTargetPath,
  draggedPath,
  onSelectEntry,
  onToggleDirectory,
  onActivateEntry,
  onOpenMenu,
  onDragStartEntry,
  onDragEndEntry,
  onDragOverDirectory,
  onDropDirectory,
  canPreviewEntry,
}: {
  path: string;
  depth: number;
  entriesByPath: Record<string, CodexLabsFileEntry[]>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  selectedPath: string | null;
  dropTargetPath: string | null;
  draggedPath: string | null;
  onSelectEntry: (entry: CodexLabsFileEntry) => void;
  onToggleDirectory: (entry: CodexLabsFileEntry) => void;
  onActivateEntry: (entry: CodexLabsFileEntry) => void;
  onOpenMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    entry: CodexLabsFileEntry
  ) => void;
  onDragStartEntry: (entry: CodexLabsFileEntry) => void;
  onDragEndEntry: () => void;
  onDragOverDirectory: (
    event: ReactDragEvent<HTMLDivElement>,
    entry: CodexLabsFileEntry
  ) => void;
  onDropDirectory: (
    event: ReactDragEvent<HTMLDivElement>,
    entry: CodexLabsFileEntry
  ) => void;
  canPreviewEntry: (entry: CodexLabsFileEntry) => boolean;
}) {
  const entries = entriesByPath[path] ?? [];

  return (
    <>
      {entries.map((entry) => {
        const isExpanded = entry.is_directory && expandedPaths.has(entry.path);

        return (
          <div key={entry.path}>
            <TreeRow
              entry={entry}
              depth={depth}
              isExpanded={Boolean(isExpanded)}
              isSelected={selectedPath === entry.path}
              isDropTarget={dropTargetPath === entry.path}
              canPreview={canPreviewEntry(entry)}
              draggedPath={draggedPath}
              onSelectEntry={onSelectEntry}
              onToggleDirectory={onToggleDirectory}
              onActivateEntry={onActivateEntry}
              onOpenMenu={onOpenMenu}
              onDragStartEntry={onDragStartEntry}
              onDragEndEntry={onDragEndEntry}
              onDragOverDirectory={onDragOverDirectory}
              onDropDirectory={onDropDirectory}
            />

            {isExpanded ? (
              <FileTreeBranch
                path={entry.path}
                depth={depth + 1}
                entriesByPath={entriesByPath}
                expandedPaths={expandedPaths}
                loadingPaths={loadingPaths}
                selectedPath={selectedPath}
                dropTargetPath={dropTargetPath}
                draggedPath={draggedPath}
                onSelectEntry={onSelectEntry}
                onToggleDirectory={onToggleDirectory}
                onActivateEntry={onActivateEntry}
                onOpenMenu={onOpenMenu}
                onDragStartEntry={onDragStartEntry}
                onDragEndEntry={onDragEndEntry}
                onDragOverDirectory={onDragOverDirectory}
                onDropDirectory={onDropDirectory}
                canPreviewEntry={canPreviewEntry}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export default function CodexLabsFileTree({
  entriesByPath,
  expandedPaths,
  loadingPaths,
  selectedPath,
  onSelectEntry,
  onToggleDirectory,
  onActivateEntry,
  onPreviewEntry,
  onDownloadEntry,
  onCopyPath,
  onRenameEntry,
  onDeleteEntry,
  onMoveEntry,
  onUploadFiles,
  canPreviewEntry,
}: CodexLabsFileTreeProps) {
  const [contextMenuState, setContextMenuState] = useState<ContextMenuState | null>(null);
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [showHiddenEntries, setShowHiddenEntries] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const rootEntries = useMemo(
    () =>
      showHiddenEntries
        ? entriesByPath[""] ?? []
        : (entriesByPath[""] ?? []).filter((entry) => !isHiddenEntry(entry)),
    [entriesByPath, showHiddenEntries]
  );
  const expandedSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const loadingSet = useMemo(() => new Set(loadingPaths), [loadingPaths]);
  const visibleEntriesByPath = useMemo(() => {
    if (showHiddenEntries) {
      return entriesByPath;
    }

    return Object.fromEntries(
      Object.entries(entriesByPath).map(([path, entries]) => [
        path,
        entries.filter((entry) => !isHiddenEntry(entry)),
      ])
    );
  }, [entriesByPath, showHiddenEntries]);
  const entryByPath = useMemo(() => {
    const result = new Map<string, CodexLabsFileEntry>();
    Object.values(entriesByPath).forEach((entries) => {
      entries.forEach((entry) => result.set(entry.path, entry));
    });
    return result;
  }, [entriesByPath]);

  const canDropToPath = useCallback(
    (destinationPath: string): boolean => {
      if (!draggedPath) {
        return false;
      }
      if (draggedPath === destinationPath) {
        return false;
      }
      if (getParentPath(draggedPath) === destinationPath) {
        return false;
      }
      if (destinationPath.startsWith(`${draggedPath}/`)) {
        return false;
      }
      return true;
    },
    [draggedPath]
  );

  useEffect(() => {
    const raw = window.localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY);
    if (raw === "1") {
      setShowHiddenEntries(true);
    } else if (raw === "0") {
      setShowHiddenEntries(false);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      SHOW_HIDDEN_STORAGE_KEY,
      showHiddenEntries ? "1" : "0"
    );
  }, [showHiddenEntries]);

  useEffect(() => {
    if (!contextMenuState) {
      return;
    }

    const handlePointerDown = () => {
      setContextMenuState(null);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenuState(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [contextMenuState]);

  useEffect(() => {
    if (!contextMenuState) {
      return;
    }

    const containerNode = containerRef.current;
    const menuNode = contextMenuRef.current;
    if (!containerNode || !menuNode) {
      return;
    }

    const maxX = Math.max(
      CONTEXT_MENU_MARGIN_PX,
      containerNode.clientWidth - menuNode.offsetWidth - CONTEXT_MENU_MARGIN_PX
    );
    const maxY = Math.max(
      CONTEXT_MENU_MARGIN_PX,
      containerNode.clientHeight - menuNode.offsetHeight - CONTEXT_MENU_MARGIN_PX
    );
    const nextX = Math.min(
      Math.max(contextMenuState.x, CONTEXT_MENU_MARGIN_PX),
      maxX
    );
    const nextY = Math.min(
      Math.max(contextMenuState.y, CONTEXT_MENU_MARGIN_PX),
      maxY
    );

    if (nextX === contextMenuState.x && nextY === contextMenuState.y) {
      return;
    }

    setContextMenuState((previousState) =>
      previousState
        ? {
            ...previousState,
            x: nextX,
            y: nextY,
          }
        : previousState
    );
  }, [contextMenuState]);

  const openContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    entry: CodexLabsFileEntry | null
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (entry) {
      onSelectEntry(entry);
    }

    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    setContextMenuState({
      entry,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  };

  const previewable = contextMenuState
    ? contextMenuState.entry !== null && canPreviewEntry(contextMenuState.entry)
    : false;
  const contextMenuEntry = contextMenuState?.entry ?? null;
  const handleDragStartEntry = (entry: CodexLabsFileEntry) => {
    setDraggedPath(entry.path);
    setDropTargetPath(null);
  };

  const handleDragEndEntry = () => {
    setDraggedPath(null);
    setDropTargetPath(null);
  };

  const handleDragOverDirectory = (
    event: ReactDragEvent<HTMLDivElement>,
    entry: CodexLabsFileEntry
  ) => {
    if (!entry.is_directory) {
      return;
    }

    if (eventHasExternalFiles(event)) {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropTargetPath(entry.path);
      return;
    }

    if (!canDropToPath(entry.path)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTargetPath(entry.path);
  };

  const handleDropDirectory = (
    event: ReactDragEvent<HTMLDivElement>,
    entry: CodexLabsFileEntry
  ) => {
    if (!entry.is_directory) {
      return;
    }

    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (droppedFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      void onUploadFiles(droppedFiles, entry.path);
      setDraggedPath(null);
      setDropTargetPath(null);
      return;
    }

    if (!draggedPath || !canDropToPath(entry.path)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const sourceEntry = entryByPath.get(draggedPath);
    if (sourceEntry) {
      onMoveEntry(sourceEntry, entry.path);
    }

    setDraggedPath(null);
    setDropTargetPath(null);
  };

  const handleDragOverRoot = (event: ReactDragEvent<HTMLDivElement>) => {
    if (eventHasExternalFiles(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDropTargetPath("");
      return;
    }

    if (!canDropToPath("")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetPath("");
  };

  const handleDropRoot = (event: ReactDragEvent<HTMLDivElement>) => {
    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (droppedFiles.length > 0) {
      event.preventDefault();
      void onUploadFiles(droppedFiles, "");
      setDraggedPath(null);
      setDropTargetPath(null);
      return;
    }

    if (!draggedPath || !canDropToPath("")) {
      return;
    }
    event.preventDefault();
    const sourceEntry = entryByPath.get(draggedPath);
    if (sourceEntry) {
      onMoveEntry(sourceEntry, "");
    }
    setDraggedPath(null);
    setDropTargetPath(null);
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full"
      onContextMenu={(event) => openContextMenu(event, null)}
      onDragOver={handleDragOverRoot}
      onDrop={handleDropRoot}
      onDragLeave={() => {
        if (dropTargetPath === "") {
          setDropTargetPath(null);
        }
      }}
    >
      <div
        className={`mb-1 rounded-08 border px-2 py-1 ${
          dropTargetPath === ""
            ? "border-border-04 bg-background-tint-02"
            : "border-transparent bg-background-neutral-01"
        }`}
      >
        <Text text03 className="text-xs">
          Drop files here to upload to home (~)
        </Text>
      </div>
      {rootEntries.length === 0 && !loadingSet.has("") ? (
        <div className="p-2">
          <Text text03>This workspace is empty.</Text>
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <FileTreeBranch
            path=""
            depth={0}
            entriesByPath={visibleEntriesByPath}
            expandedPaths={expandedSet}
            loadingPaths={loadingSet}
            selectedPath={selectedPath}
            dropTargetPath={dropTargetPath}
            draggedPath={draggedPath}
            onSelectEntry={onSelectEntry}
            onToggleDirectory={onToggleDirectory}
            onActivateEntry={onActivateEntry}
            onOpenMenu={openContextMenu}
            onDragStartEntry={handleDragStartEntry}
            onDragEndEntry={handleDragEndEntry}
            onDragOverDirectory={handleDragOverDirectory}
            onDropDirectory={handleDropDirectory}
            canPreviewEntry={canPreviewEntry}
          />
        </div>
      )}

      {contextMenuState ? (
        <div
          ref={contextMenuRef}
          className="absolute z-30 min-w-[11rem] overflow-hidden rounded-12 border border-border-01 bg-background-neutral-00 p-1 shadow-2xl"
          style={{ left: contextMenuState.x, top: contextMenuState.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextMenuEntry?.is_directory ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-08 px-2 py-1.5 text-left hover:bg-background-neutral-01"
              onClick={() => {
                if (contextMenuEntry) {
                  onToggleDirectory(contextMenuEntry);
                }
                setContextMenuState(null);
              }}
            >
              {contextMenuEntry && expandedSet.has(contextMenuEntry.path) ? (
                <SvgFolderOpen className="h-4 w-4 shrink-0 stroke-text-03" />
              ) : (
                <SvgFolder className="h-4 w-4 shrink-0 stroke-text-03" />
              )}
              <Text>
                {contextMenuEntry && expandedSet.has(contextMenuEntry.path)
                  ? "Collapse"
                  : "Open"}
              </Text>
            </button>
          ) : previewable ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-08 px-2 py-1.5 text-left hover:bg-background-neutral-01"
              onClick={() => {
                if (contextMenuEntry) {
                  onPreviewEntry(contextMenuEntry);
                }
                setContextMenuState(null);
              }}
            >
              <SvgEye className="h-4 w-4 shrink-0 stroke-text-03" />
              <Text>Preview</Text>
            </button>
          ) : null}

          {contextMenuEntry && !contextMenuEntry.is_directory ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-08 px-2 py-1.5 text-left hover:bg-background-neutral-01"
              onClick={() => {
                onDownloadEntry(contextMenuEntry);
                setContextMenuState(null);
              }}
            >
              <SvgDownloadCloud className="h-4 w-4 shrink-0 stroke-text-03" />
              <Text>Download</Text>
            </button>
          ) : null}

          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-08 px-2 py-1.5 text-left hover:bg-background-neutral-01"
            onClick={() => {
              setShowHiddenEntries((previousState) => !previousState);
              setContextMenuState(null);
            }}
          >
            <SvgEye className="h-4 w-4 shrink-0 stroke-text-03" />
            <Text>
              {showHiddenEntries
                ? "Hide hidden files/folders"
                : "Show hidden files/folders"}
            </Text>
          </button>

          {contextMenuEntry ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-08 px-2 py-1.5 text-left hover:bg-background-neutral-01"
              onClick={() => {
                onCopyPath(contextMenuEntry);
                setContextMenuState(null);
              }}
            >
              <SvgCopy className="h-4 w-4 shrink-0 stroke-text-03" />
              <Text>Copy path</Text>
            </button>
          ) : null}

          {contextMenuEntry ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-08 px-2 py-1.5 text-left hover:bg-background-neutral-01"
              onClick={() => {
                onRenameEntry(contextMenuEntry);
                setContextMenuState(null);
              }}
            >
              <SvgChevronRight className="h-4 w-4 shrink-0 stroke-text-03" />
              <Text>Rename</Text>
            </button>
          ) : null}

          {contextMenuEntry ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-08 px-2 py-1.5 text-left text-red-600 hover:bg-background-neutral-01"
              onClick={() => {
                onDeleteEntry(contextMenuEntry);
                setContextMenuState(null);
              }}
            >
              <SvgChevronDown className="h-4 w-4 shrink-0 stroke-current" />
              <Text>Delete</Text>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
