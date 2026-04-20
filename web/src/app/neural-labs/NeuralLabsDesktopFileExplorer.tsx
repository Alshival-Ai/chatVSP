"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Text from "@/refresh-components/texts/Text";
import type {
  DesktopExplorerViewMode,
  NeuralLabsFileEntry,
} from "@/app/neural-labs/types";
import {
  SvgChevronLeft,
  SvgChevronRight,
  SvgChevronUp,
  SvgCopy,
  SvgDownloadCloud,
  SvgEye,
  SvgFileText,
  SvgFolder,
  SvgFolderOpen,
  SvgFolderPlus,
  SvgHardDrive,
  SvgRefreshCw,
  SvgTrash,
  SvgUploadCloud,
} from "@opal/icons";

const CONTEXT_MENU_MARGIN_PX = 8;

interface ContextMenuState {
  entry: NeuralLabsFileEntry | null;
  x: number;
  y: number;
}

interface NeuralLabsDesktopFileExplorerProps {
  currentPath: string;
  entries: NeuralLabsFileEntry[];
  rootEntries: NeuralLabsFileEntry[];
  selectedPaths: string[];
  anchorPath: string | null;
  viewMode: DesktopExplorerViewMode;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canGoUp: boolean;
  canPreviewEntry: (entry: NeuralLabsFileEntry) => boolean;
  onNavigateBack: () => Promise<void> | void;
  onNavigateForward: () => Promise<void> | void;
  onNavigateUp: () => Promise<void> | void;
  onNavigateToPath: (path: string) => Promise<void> | void;
  onRefreshDirectory: () => Promise<void> | void;
  onCreateFolder: () => Promise<void> | void;
  onUploadFiles: (
    files: File[],
    destinationPath: string
  ) => Promise<void> | void;
  onSelectionChange: (paths: string[], anchorPath: string | null) => void;
  onSetViewMode: (mode: DesktopExplorerViewMode) => void;
  onOpenEntry: (entry: NeuralLabsFileEntry) => void;
  onPreviewEntry: (entry: NeuralLabsFileEntry) => void;
  onDownloadEntry: (entry: NeuralLabsFileEntry) => void;
  onCopyPath: (entry: NeuralLabsFileEntry) => void;
  onRenameEntry: (entry: NeuralLabsFileEntry) => void;
  onDeleteEntry: (entry: NeuralLabsFileEntry) => void;
  onMoveEntries: (
    entries: NeuralLabsFileEntry[],
    destinationPath: string
  ) => Promise<void> | void;
}

function getParentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function getPathSegments(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return parts.map((part, index) => ({
    label: part,
    path: parts.slice(0, index + 1).join("/"),
  }));
}

function formatPathLabel(path: string): string {
  return path ? `~/${path}` : "~";
}

function formatBytes(size: number | null): string {
  if (typeof size !== "number" || !Number.isFinite(size)) {
    return "Folder";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${
    units[unitIndex]
  }`;
}

function formatModifiedAt(modifiedAt: string | null): string {
  if (!modifiedAt) {
    return "Unknown";
  }
  const timestamp = new Date(modifiedAt);
  if (Number.isNaN(timestamp.getTime())) {
    return "Unknown";
  }
  return timestamp.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function sortEntries(entries: NeuralLabsFileEntry[]): NeuralLabsFileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.is_directory !== right.is_directory) {
      return left.is_directory ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function eventHasExternalFiles(event: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function isInvalidDestination(
  sourcePath: string,
  destinationPath: string
): boolean {
  if (sourcePath === destinationPath) {
    return true;
  }
  if (getParentPath(sourcePath) === destinationPath) {
    return true;
  }
  return destinationPath.startsWith(`${sourcePath}/`);
}

export default function NeuralLabsDesktopFileExplorer({
  currentPath,
  entries,
  rootEntries,
  selectedPaths,
  anchorPath,
  viewMode,
  isLoading,
  canGoBack,
  canGoForward,
  canGoUp,
  canPreviewEntry,
  onNavigateBack,
  onNavigateForward,
  onNavigateUp,
  onNavigateToPath,
  onRefreshDirectory,
  onCreateFolder,
  onUploadFiles,
  onSelectionChange,
  onSetViewMode,
  onOpenEntry,
  onPreviewEntry,
  onDownloadEntry,
  onCopyPath,
  onRenameEntry,
  onDeleteEntry,
  onMoveEntries,
}: NeuralLabsDesktopFileExplorerProps) {
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [draggedPaths, setDraggedPaths] = useState<string[]>([]);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [contextMenuState, setContextMenuState] =
    useState<ContextMenuState | null>(null);

  const selectedPathSet = useMemo(
    () => new Set(selectedPaths),
    [selectedPaths]
  );
  const orderedEntries = useMemo(() => sortEntries(entries), [entries]);
  const orderedRootDirectories = useMemo(
    () => sortEntries(rootEntries.filter((entry) => entry.is_directory)),
    [rootEntries]
  );
  const entryByPath = useMemo(() => {
    const map = new Map<string, NeuralLabsFileEntry>();
    orderedEntries.forEach((entry) => map.set(entry.path, entry));
    orderedRootDirectories.forEach((entry) => map.set(entry.path, entry));
    return map;
  }, [orderedEntries, orderedRootDirectories]);

  const currentDirectoryLabel = useMemo(
    () => formatPathLabel(currentPath),
    [currentPath]
  );
  const breadcrumbs = useMemo(
    () => getPathSegments(currentPath),
    [currentPath]
  );
  const sidebarLocations = useMemo(() => {
    const items: { label: string; path: string; icon: "home" | "folder" }[] = [
      { label: "Workspace", path: "", icon: "home" },
    ];

    breadcrumbs.forEach((crumb) => {
      items.push({
        label: crumb.label,
        path: crumb.path,
        icon: "folder",
      });
    });

    orderedRootDirectories.forEach((entry) => {
      if (items.some((item) => item.path === entry.path)) {
        return;
      }
      items.push({
        label: entry.name,
        path: entry.path,
        icon: "folder",
      });
    });

    return items;
  }, [breadcrumbs, orderedRootDirectories]);

  useEffect(() => {
    if (!contextMenuState) {
      return;
    }

    const handlePointerDown = () => setContextMenuState(null);
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
      containerNode.clientHeight -
        menuNode.offsetHeight -
        CONTEXT_MENU_MARGIN_PX
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
      previousState ? { ...previousState, x: nextX, y: nextY } : previousState
    );
  }, [contextMenuState]);

  const handleUploadClick = () => {
    uploadInputRef.current?.click();
  };

  const commitSelection = (
    entry: NeuralLabsFileEntry,
    event?: Pick<
      ReactMouseEvent<HTMLElement>,
      "metaKey" | "ctrlKey" | "shiftKey"
    >
  ) => {
    const orderedPaths = orderedEntries.map((candidate) => candidate.path);

    if (event?.shiftKey && anchorPath && orderedPaths.includes(anchorPath)) {
      const anchorIndex = orderedPaths.indexOf(anchorPath);
      const entryIndex = orderedPaths.indexOf(entry.path);
      if (anchorIndex !== -1 && entryIndex !== -1) {
        const [start, end] =
          anchorIndex <= entryIndex
            ? [anchorIndex, entryIndex]
            : [entryIndex, anchorIndex];
        onSelectionChange(orderedPaths.slice(start, end + 1), anchorPath);
        return;
      }
    }

    if (event?.metaKey || event?.ctrlKey) {
      if (selectedPathSet.has(entry.path)) {
        const nextPaths = selectedPaths.filter((path) => path !== entry.path);
        onSelectionChange(nextPaths, nextPaths[nextPaths.length - 1] ?? null);
        return;
      }

      onSelectionChange([...selectedPaths, entry.path], entry.path);
      return;
    }

    onSelectionChange([entry.path], entry.path);
  };

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    entry: NeuralLabsFileEntry | null
  ) => {
    event.preventDefault();
    event.stopPropagation();

    if (entry && !selectedPathSet.has(entry.path)) {
      onSelectionChange([entry.path], entry.path);
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

  const canDropToPath = (destinationPath: string): boolean => {
    if (draggedPaths.length === 0) {
      return false;
    }

    return draggedPaths.every(
      (sourcePath) => !isInvalidDestination(sourcePath, destinationPath)
    );
  };

  const handleDragStart = (
    event: ReactDragEvent<HTMLElement>,
    entry: NeuralLabsFileEntry
  ) => {
    const nextDraggedPaths =
      selectedPathSet.has(entry.path) && selectedPaths.length > 0
        ? selectedPaths
        : [entry.path];
    if (!selectedPathSet.has(entry.path)) {
      onSelectionChange([entry.path], entry.path);
    }
    setDraggedPaths(nextDraggedPaths);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", entry.path);
  };

  const clearDragState = () => {
    setDraggedPaths([]);
    setDropTargetPath(null);
  };

  const handleDropToPath = async (
    event: ReactDragEvent<HTMLElement>,
    destinationPath: string
  ) => {
    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (droppedFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      await onUploadFiles(droppedFiles, destinationPath);
      clearDragState();
      return;
    }

    if (!canDropToPath(destinationPath)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const draggedEntries = draggedPaths
      .map((path) => entryByPath.get(path))
      .filter((entry): entry is NeuralLabsFileEntry => Boolean(entry));
    if (draggedEntries.length > 0) {
      await onMoveEntries(draggedEntries, destinationPath);
      onSelectionChange([], null);
    }
    clearDragState();
  };

  const previewable = contextMenuState?.entry
    ? canPreviewEntry(contextMenuState.entry)
    : false;

  return (
    <div
      ref={containerRef}
      className="relative flex h-full min-h-0 bg-[#eff3f8]"
      onContextMenu={(event) => openContextMenu(event, null)}
    >
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = event.target.files
            ? Array.from(event.target.files)
            : [];
          event.target.value = "";
          void onUploadFiles(files, currentPath);
        }}
      />

      <aside className="flex w-[15rem] shrink-0 flex-col border-r border-slate-200 bg-[#e7edf6]/95">
        <div className="border-b border-slate-200 px-4 py-3">
          <Text mainUiAction className="text-slate-900">
            File Explorer
          </Text>
          <Text text03 className="mt-1 text-xs text-slate-500">
            {currentDirectoryLabel}
          </Text>
        </div>

        <div className="default-scrollbar min-h-0 flex-1 overflow-auto px-3 py-3">
          <div className="mb-5">
            <Text
              text03
              className="px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500"
            >
              Favorites
            </Text>
            <div className="mt-2 flex flex-col gap-1">
              {sidebarLocations.map((item) => {
                const isActive = item.path === currentPath;
                return (
                  <button
                    key={`${item.icon}:${item.path}`}
                    type="button"
                    className={`flex w-full items-center gap-2 rounded-12 px-2.5 py-2 text-left transition ${
                      isActive
                        ? "bg-white text-slate-900 shadow-sm"
                        : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
                    }`}
                    onClick={() => void onNavigateToPath(item.path)}
                    onDragOver={(event) => {
                      if (
                        eventHasExternalFiles(event) ||
                        canDropToPath(item.path)
                      ) {
                        event.preventDefault();
                        event.dataTransfer.dropEffect = eventHasExternalFiles(
                          event
                        )
                          ? "copy"
                          : "move";
                        setDropTargetPath(item.path);
                      }
                    }}
                    onDragLeave={() => {
                      if (dropTargetPath === item.path) {
                        setDropTargetPath(null);
                      }
                    }}
                    onDrop={(event) => void handleDropToPath(event, item.path)}
                  >
                    {item.icon === "home" ? (
                      <SvgHardDrive className="h-4 w-4 shrink-0 stroke-current" />
                    ) : item.path === currentPath ? (
                      <SvgFolderOpen className="h-4 w-4 shrink-0 stroke-current" />
                    ) : (
                      <SvgFolder className="h-4 w-4 shrink-0 stroke-current" />
                    )}
                    <Text className="truncate">{item.label}</Text>
                    {dropTargetPath === item.path ? (
                      <span className="ml-auto h-2 w-2 rounded-full bg-sky-500" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {orderedRootDirectories.length > 0 ? (
            <div>
              <Text
                text03
                className="px-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500"
              >
                Root Folders
              </Text>
              <div className="mt-2 flex flex-col gap-1">
                {orderedRootDirectories.map((entry) => {
                  const isActive = entry.path === currentPath;
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      className={`flex w-full items-center gap-2 rounded-12 px-2.5 py-2 text-left transition ${
                        isActive
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
                      }`}
                      onClick={() => void onNavigateToPath(entry.path)}
                      onContextMenu={(event) => openContextMenu(event, entry)}
                      onDragOver={(event) => {
                        if (
                          eventHasExternalFiles(event) ||
                          canDropToPath(entry.path)
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = eventHasExternalFiles(
                            event
                          )
                            ? "copy"
                            : "move";
                          setDropTargetPath(entry.path);
                        }
                      }}
                      onDragLeave={() => {
                        if (dropTargetPath === entry.path) {
                          setDropTargetPath(null);
                        }
                      }}
                      onDrop={(event) =>
                        void handleDropToPath(event, entry.path)
                      }
                    >
                      <SvgFolder className="h-4 w-4 shrink-0 stroke-current" />
                      <Text className="truncate">{entry.name}</Text>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="border-b border-slate-200 bg-white/85 px-4 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-1.5 py-1">
              <button
                type="button"
                aria-label="Back"
                className={`rounded-full p-1.5 ${
                  canGoBack
                    ? "text-slate-700 hover:bg-white"
                    : "cursor-not-allowed text-slate-300"
                }`}
                disabled={!canGoBack}
                onClick={() => void onNavigateBack()}
              >
                <SvgChevronLeft className="h-4 w-4 stroke-current" />
              </button>
              <button
                type="button"
                aria-label="Forward"
                className={`rounded-full p-1.5 ${
                  canGoForward
                    ? "text-slate-700 hover:bg-white"
                    : "cursor-not-allowed text-slate-300"
                }`}
                disabled={!canGoForward}
                onClick={() => void onNavigateForward()}
              >
                <SvgChevronRight className="h-4 w-4 stroke-current" />
              </button>
              <button
                type="button"
                aria-label="Up"
                className={`rounded-full p-1.5 ${
                  canGoUp
                    ? "text-slate-700 hover:bg-white"
                    : "cursor-not-allowed text-slate-300"
                }`}
                disabled={!canGoUp}
                onClick={() => void onNavigateUp()}
              >
                <SvgChevronUp className="h-4 w-4 stroke-current" />
              </button>
            </div>

            <div className="min-w-0 flex-1 rounded-full border border-slate-200 bg-slate-50 px-3 py-2">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  className={`rounded-full px-2 py-1 text-sm ${
                    currentPath === ""
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600 hover:bg-white"
                  }`}
                  onClick={() => void onNavigateToPath("")}
                >
                  ~
                </button>
                {breadcrumbs.map((crumb) => (
                  <div
                    key={crumb.path}
                    className="flex min-w-0 items-center gap-1.5"
                  >
                    <SvgChevronRight className="h-3.5 w-3.5 shrink-0 stroke-slate-400" />
                    <button
                      type="button"
                      className={`min-w-0 rounded-full px-2 py-1 text-sm ${
                        crumb.path === currentPath
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-600 hover:bg-white"
                      }`}
                      onClick={() => void onNavigateToPath(crumb.path)}
                    >
                      <span className="block truncate">{crumb.label}</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                className={`rounded-full px-3 py-2 text-sm ${
                  viewMode === "icon"
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
                onClick={() => onSetViewMode("icon")}
              >
                Icons
              </button>
              <button
                type="button"
                className={`rounded-full px-3 py-2 text-sm ${
                  viewMode === "list"
                    ? "bg-slate-900 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
                onClick={() => onSetViewMode("list")}
              >
                List
              </button>
            </div>

            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded-full bg-slate-100 p-2 text-slate-700 transition hover:bg-slate-200"
                aria-label="New folder"
                onClick={() => void onCreateFolder()}
              >
                <SvgFolderPlus className="h-4 w-4 stroke-current" />
              </button>
              <button
                type="button"
                className="rounded-full bg-slate-100 p-2 text-slate-700 transition hover:bg-slate-200"
                aria-label="Upload files"
                onClick={handleUploadClick}
              >
                <SvgUploadCloud className="h-4 w-4 stroke-current" />
              </button>
              <button
                type="button"
                className="rounded-full bg-slate-100 p-2 text-slate-700 transition hover:bg-slate-200"
                aria-label="Refresh"
                onClick={() => void onRefreshDirectory()}
              >
                <SvgRefreshCw className="h-4 w-4 stroke-current" />
              </button>
            </div>
          </div>
        </div>

        <div
          className={`relative min-h-0 flex-1 overflow-hidden ${
            dropTargetPath === currentPath
              ? "bg-sky-50"
              : "bg-[linear-gradient(180deg,#f7f9fc_0%,#edf3f9_100%)]"
          }`}
          onClick={() => onSelectionChange([], null)}
          onDragOver={(event) => {
            if (eventHasExternalFiles(event) || canDropToPath(currentPath)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = eventHasExternalFiles(event)
                ? "copy"
                : "move";
              setDropTargetPath(currentPath);
            }
          }}
          onDragLeave={() => {
            if (dropTargetPath === currentPath) {
              setDropTargetPath(null);
            }
          }}
          onDrop={(event) => void handleDropToPath(event, currentPath)}
        >
          <div className="border-b border-slate-200/70 px-4 py-2">
            <Text
              text03
              className="text-xs uppercase tracking-[0.18em] text-slate-500"
            >
              {selectedPaths.length > 1
                ? `${selectedPaths.length} items selected`
                : selectedPaths.length === 1
                  ? "1 item selected"
                  : currentDirectoryLabel}
            </Text>
          </div>

          <div className="default-scrollbar h-full overflow-auto p-4">
            {isLoading ? (
              <div className="flex h-full items-center justify-center">
                <Text text03>Loading folder contents…</Text>
              </div>
            ) : orderedEntries.length === 0 ? (
              <div className="flex h-full min-h-[14rem] flex-col items-center justify-center rounded-[1.5rem] border border-dashed border-slate-300 bg-white/60 px-6 text-center">
                <SvgFolderOpen className="h-10 w-10 stroke-slate-300" />
                <Text className="mt-4 font-medium text-slate-800">
                  This folder is empty
                </Text>
                <Text text03 className="mt-2 max-w-sm text-slate-500">
                  Drag files here to upload them, or create a new folder to get
                  started.
                </Text>
              </div>
            ) : viewMode === "icon" ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-3">
                {orderedEntries.map((entry) => {
                  const isSelected = selectedPathSet.has(entry.path);
                  const isDropTarget = dropTargetPath === entry.path;
                  return (
                    <button
                      key={entry.path}
                      type="button"
                      draggable
                      className={`group flex min-h-[8.75rem] flex-col rounded-[1.15rem] border px-3 py-3 text-left transition ${
                        isDropTarget
                          ? "border-sky-400 bg-sky-50 shadow-[0_0_0_1px_rgba(56,189,248,0.2)]"
                          : isSelected
                            ? "border-slate-900 bg-white shadow-[0_14px_32px_rgba(15,23,42,0.14)]"
                            : "border-transparent bg-white/78 hover:border-slate-200 hover:bg-white"
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();
                        commitSelection(entry, event);
                      }}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        if (entry.is_directory) {
                          void onNavigateToPath(entry.path);
                          return;
                        }
                        onOpenEntry(entry);
                      }}
                      onContextMenu={(event) => openContextMenu(event, entry)}
                      onDragStart={(event) => handleDragStart(event, entry)}
                      onDragEnd={clearDragState}
                      onDragOver={(event) => {
                        if (
                          entry.is_directory &&
                          (eventHasExternalFiles(event) ||
                            canDropToPath(entry.path))
                        ) {
                          event.preventDefault();
                          event.stopPropagation();
                          event.dataTransfer.dropEffect = eventHasExternalFiles(
                            event
                          )
                            ? "copy"
                            : "move";
                          setDropTargetPath(entry.path);
                        }
                      }}
                      onDragLeave={() => {
                        if (dropTargetPath === entry.path) {
                          setDropTargetPath(null);
                        }
                      }}
                      onDrop={(event) => {
                        if (entry.is_directory) {
                          void handleDropToPath(event, entry.path);
                        }
                      }}
                    >
                      <div className="flex items-start justify-between">
                        {entry.is_directory ? (
                          <SvgFolderOpen className="h-9 w-9 shrink-0 stroke-slate-700" />
                        ) : (
                          <SvgFileText className="h-9 w-9 shrink-0 stroke-slate-700" />
                        )}
                        {!entry.is_directory && canPreviewEntry(entry) ? (
                          <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                            Preview
                          </span>
                        ) : null}
                      </div>
                      <Text className="mt-4 line-clamp-2 break-words font-medium text-slate-900">
                        {entry.name}
                      </Text>
                      <Text text03 className="mt-auto text-xs text-slate-500">
                        {entry.is_directory
                          ? "Folder"
                          : formatBytes(entry.size)}
                      </Text>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="overflow-hidden rounded-[1.25rem] border border-slate-200 bg-white">
                <div className="grid grid-cols-[minmax(0,1.75fr)_7rem_10rem] gap-4 border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <span>Name</span>
                  <span>Size</span>
                  <span>Modified</span>
                </div>
                <div className="divide-y divide-slate-100">
                  {orderedEntries.map((entry) => {
                    const isSelected = selectedPathSet.has(entry.path);
                    const isDropTarget = dropTargetPath === entry.path;
                    return (
                      <button
                        key={entry.path}
                        type="button"
                        draggable
                        className={`grid w-full grid-cols-[minmax(0,1.75fr)_7rem_10rem] gap-4 px-4 py-3 text-left transition ${
                          isDropTarget
                            ? "bg-sky-50"
                            : isSelected
                              ? "bg-slate-900 text-white"
                              : "text-slate-700 hover:bg-slate-50"
                        }`}
                        onClick={(event) => {
                          event.stopPropagation();
                          commitSelection(entry, event);
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          if (entry.is_directory) {
                            void onNavigateToPath(entry.path);
                            return;
                          }
                          onOpenEntry(entry);
                        }}
                        onContextMenu={(event) => openContextMenu(event, entry)}
                        onDragStart={(event) => handleDragStart(event, entry)}
                        onDragEnd={clearDragState}
                        onDragOver={(event) => {
                          if (
                            entry.is_directory &&
                            (eventHasExternalFiles(event) ||
                              canDropToPath(entry.path))
                          ) {
                            event.preventDefault();
                            event.stopPropagation();
                            event.dataTransfer.dropEffect =
                              eventHasExternalFiles(event) ? "copy" : "move";
                            setDropTargetPath(entry.path);
                          }
                        }}
                        onDragLeave={() => {
                          if (dropTargetPath === entry.path) {
                            setDropTargetPath(null);
                          }
                        }}
                        onDrop={(event) => {
                          if (entry.is_directory) {
                            void handleDropToPath(event, entry.path);
                          }
                        }}
                      >
                        <span className="flex min-w-0 items-center gap-3">
                          {entry.is_directory ? (
                            <SvgFolder className="h-4 w-4 shrink-0 stroke-current" />
                          ) : (
                            <SvgFileText className="h-4 w-4 shrink-0 stroke-current" />
                          )}
                          <span className="truncate">{entry.name}</span>
                        </span>
                        <span className="truncate text-sm">
                          {entry.is_directory
                            ? "Folder"
                            : formatBytes(entry.size)}
                        </span>
                        <span className="truncate text-sm">
                          {formatModifiedAt(entry.modified_at)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {contextMenuState ? (
        <div
          ref={contextMenuRef}
          className="absolute z-30 min-w-[13rem] overflow-hidden rounded-16 border border-slate-200 bg-white p-1.5 shadow-[0_20px_50px_rgba(15,23,42,0.18)]"
          style={{ left: contextMenuState.x, top: contextMenuState.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextMenuState.entry?.is_directory ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-12 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => {
                if (contextMenuState.entry) {
                  void onNavigateToPath(contextMenuState.entry.path);
                }
                setContextMenuState(null);
              }}
            >
              <SvgFolderOpen className="h-4 w-4 shrink-0 stroke-current" />
              <Text>Open Folder</Text>
            </button>
          ) : contextMenuState.entry ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-12 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => {
                onOpenEntry(contextMenuState.entry!);
                setContextMenuState(null);
              }}
            >
              <SvgFileText className="h-4 w-4 shrink-0 stroke-current" />
              <Text>Open</Text>
            </button>
          ) : null}

          {contextMenuState.entry && previewable ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-12 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => {
                onPreviewEntry(contextMenuState.entry!);
                setContextMenuState(null);
              }}
            >
              <SvgEye className="h-4 w-4 shrink-0 stroke-current" />
              <Text>Preview</Text>
            </button>
          ) : null}

          {contextMenuState.entry && !contextMenuState.entry.is_directory ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-12 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => {
                onDownloadEntry(contextMenuState.entry!);
                setContextMenuState(null);
              }}
            >
              <SvgDownloadCloud className="h-4 w-4 shrink-0 stroke-current" />
              <Text>Download</Text>
            </button>
          ) : null}

          {contextMenuState.entry ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-12 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => {
                onCopyPath(contextMenuState.entry!);
                setContextMenuState(null);
              }}
            >
              <SvgCopy className="h-4 w-4 shrink-0 stroke-current" />
              <Text>Copy Path</Text>
            </button>
          ) : null}

          {contextMenuState.entry ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-12 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => {
                onRenameEntry(contextMenuState.entry!);
                setContextMenuState(null);
              }}
            >
              <SvgChevronRight className="h-4 w-4 shrink-0 stroke-current" />
              <Text>Rename</Text>
            </button>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-12 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
              onClick={() => {
                void onCreateFolder();
                setContextMenuState(null);
              }}
            >
              <SvgFolderPlus className="h-4 w-4 shrink-0 stroke-current" />
              <Text>New Folder</Text>
            </button>
          )}

          {contextMenuState.entry ? (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-12 px-3 py-2 text-left text-sm text-red-600 hover:bg-red-50"
              onClick={() => {
                onDeleteEntry(contextMenuState.entry!);
                setContextMenuState(null);
              }}
            >
              <SvgTrash className="h-4 w-4 shrink-0 stroke-current" />
              <Text>Delete</Text>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
