"use client";

import "@xterm/xterm/css/xterm.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type ReactElement,
  type RefObject,
} from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import Button from "@/refresh-components/buttons/Button";
import InputSelect from "@/refresh-components/inputs/InputSelect";
import Text from "@/refresh-components/texts/Text";
import { toast } from "@/hooks/useToast";
import ColorSwatch from "@/refresh-components/ColorSwatch";
import NeuralLabsDesktopFileExplorer from "@/app/neural-labs/NeuralLabsDesktopFileExplorer";
import NeuralLabsDesktopTextEditor from "@/app/neural-labs/NeuralLabsDesktopTextEditor";
import NeuralLabsDesktopTerminal from "@/app/neural-labs/NeuralLabsDesktopTerminal";
import NeuralLabsDesktopWindows from "@/app/neural-labs/NeuralLabsDesktopWindows";
import NeuralLabsFileTree from "@/app/neural-labs/NeuralLabsFileTree";
import NeuralLabsPreviewWindows from "@/app/neural-labs/NeuralLabsPreviewWindows";
import NeuralLabsTooltip from "@/app/neural-labs/NeuralLabsTooltip";
import type {
  DesktopEditorTabState,
  DesktopEditorWindowState,
  DesktopTerminalWindowState,
  DesktopExplorerState,
  DesktopWindowState,
  TerminalLayoutState,
  TerminalPaneState,
  TerminalTabState,
  NeuralLabsFileEntry,
  DirectoryResponse,
  PreviewKind,
  PreviewWindowState,
  SplitMode,
} from "@/app/neural-labs/types";
import { ThemePreference } from "@/lib/types";
import { useUser } from "@/providers/UserProvider";
import {
  SvgArrowLeft,
  SvgChevronLeft,
  SvgChevronRight,
  SvgFileText,
  SvgFolder,
  SvgFolderPlus,
  SvgRefreshCw,
  SvgSettings,
  SvgTerminal,
  SvgTrash,
  SvgUploadCloud,
} from "@opal/icons";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

interface TerminalDescriptor {
  terminal_id: string;
}

interface TerminalListResponse {
  terminals: TerminalDescriptor[];
}

interface WarmupResponse {
  home_dir: string;
  terminal_id: string | null;
}

interface TerminalStatusResponse {
  terminal_id: string;
  state: "initializing" | "ready" | "exited" | string;
  alive: boolean;
  created_at_epoch: number;
  first_output_at_epoch: number | null;
  last_activity_epoch: number;
  has_output: boolean;
}

interface TerminalWebSocketTokenResponse {
  token: string;
  ws_path: string;
}

type DesktopBackgroundPresetId =
  | "aurora"
  | "graphite"
  | "sunset-grid"
  | "ocean-night";
type DesktopBackgroundSelection =
  | DesktopBackgroundPresetId
  | `custom:${string}`;

interface PersistedTerminalLayout {
  tabs: TerminalTabState[];
  active_tab_id: string;
}

interface PersistedTreeState {
  current_path: string;
  expanded_paths: string[];
  selected_path: string | null;
}

interface DirectoryLoadOptions {
  silent?: boolean;
}

interface TerminalPaneProps {
  terminalId: string;
  isActive: boolean;
  onFocus: () => void;
}

interface TaskbarMenuState {
  appKind: DesktopWindowState["app_kind"] | "text-editor";
  x: number;
  y: number;
}

function IconActionButton({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}) {
  return <NeuralLabsTooltip label={label}>{children}</NeuralLabsTooltip>;
}

const NEURAL_LABS_API_PREFIX = "/api/neural-labs";
const NEURAL_LABS_TERMINAL_WS_PATH = "/api/neural-labs/terminal/ws";
const LAYOUT_STORAGE_KEY = "neural-labs-layout-v1";
const TREE_STATE_STORAGE_KEY = "neural-labs-tree-v1";
const PREVIEW_WINDOWS_STORAGE_KEY = "neural-labs-previews-v1";
const DESKTOP_BACKGROUND_STORAGE_KEY = "neural-labs-desktop-background-v1";
const DESKTOP_CUSTOM_BACKGROUND_PATH_STORAGE_KEY =
  "neural-labs-desktop-custom-background-path-v1";
const NAVIGATOR_WIDTH_STORAGE_KEY = "neural-labs-navigator-width-v1";
const NAVIGATOR_COLLAPSED_STORAGE_KEY = "neural-labs-navigator-collapsed-v1";
const TERMINAL_NAVIGATOR_COLLAPSED_STORAGE_KEY =
  "neural-labs-terminal-navigator-collapsed-v1";
const CUSTOM_DESKTOP_BACKGROUND_PREFIX = "custom:";
const CUSTOM_DESKTOP_BACKGROUND_DIRECTORY = ".neural-labs/backgrounds";
const TREE_AUTO_SYNC_INTERVAL_MS = 1500;
const DEFAULT_NAVIGATOR_WIDTH_PX = 420;
const MIN_NAVIGATOR_WIDTH_PX = 260;
const MAX_NAVIGATOR_WIDTH_PX = 860;
const MAX_NAVIGATOR_WIDTH_RATIO = 0.7;
const COLLAPSED_NAVIGATOR_RAIL_PX = 52;
const DEFAULT_FILE_EXPLORER_WINDOW = {
  width: 460,
  height: 620,
};
const DEFAULT_TERMINAL_WINDOW = {
  width: 980,
  height: 640,
};
const DEFAULT_SETTINGS_WINDOW = {
  width: 520,
  height: 420,
};
const DEFAULT_TEXT_EDITOR_WINDOW = {
  width: 1080,
  height: 700,
};
const DESKTOP_BACKGROUND_PRESETS: {
  id: DesktopBackgroundPresetId;
  name: string;
  previewClassName: string;
  desktopClassName: string;
}[] = [
  {
    id: "aurora",
    name: "Aurora",
    previewClassName:
      "bg-[radial-gradient(circle_at_top_left,rgba(76,152,255,0.85),transparent_35%),radial-gradient(circle_at_top_right,rgba(0,212,170,0.65),transparent_32%),linear-gradient(180deg,#0a1220_0%,#060b16_55%,#05070f_100%)]",
    desktopClassName:
      "bg-[radial-gradient(circle_at_top_left,rgba(76,152,255,0.22),transparent_34%),radial-gradient(circle_at_top_right,rgba(0,212,170,0.18),transparent_28%),linear-gradient(180deg,#0a1220_0%,#060b16_55%,#05070f_100%)]",
  },
  {
    id: "graphite",
    name: "Graphite",
    previewClassName:
      "bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.16),transparent_34%),linear-gradient(140deg,#161a22_0%,#0d1017_45%,#05070c_100%)]",
    desktopClassName:
      "bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_34%),linear-gradient(140deg,#161a22_0%,#0d1017_45%,#05070c_100%)]",
  },
  {
    id: "sunset-grid",
    name: "Sunset Grid",
    previewClassName:
      "bg-[linear-gradient(135deg,#2b1021_0%,#451835_35%,#1f1f49_100%)]",
    desktopClassName:
      "bg-[linear-gradient(135deg,#2b1021_0%,#451835_35%,#1f1f49_100%)]",
  },
  {
    id: "ocean-night",
    name: "Ocean Night",
    previewClassName:
      "bg-[radial-gradient(circle_at_bottom_left,rgba(25,134,194,0.45),transparent_32%),radial-gradient(circle_at_top_right,rgba(39,209,154,0.26),transparent_25%),linear-gradient(180deg,#08131f_0%,#07111a_45%,#03070c_100%)]",
    desktopClassName:
      "bg-[radial-gradient(circle_at_bottom_left,rgba(25,134,194,0.2),transparent_32%),radial-gradient(circle_at_top_right,rgba(39,209,154,0.14),transparent_25%),linear-gradient(180deg,#08131f_0%,#07111a_45%,#03070c_100%)]",
  },
];

function isDesktopBackgroundPresetId(
  value: string
): value is DesktopBackgroundPresetId {
  return DESKTOP_BACKGROUND_PRESETS.some((preset) => preset.id === value);
}

function createCustomDesktopBackgroundSelection(
  path: string
): DesktopBackgroundSelection {
  return `${CUSTOM_DESKTOP_BACKGROUND_PREFIX}${path}`;
}

function getCustomDesktopBackgroundPath(
  selection: DesktopBackgroundSelection
): string | null {
  if (!selection.startsWith(CUSTOM_DESKTOP_BACKGROUND_PREFIX)) {
    return null;
  }

  const path = selection.slice(CUSTOM_DESKTOP_BACKGROUND_PREFIX.length).trim();
  return path || null;
}

function getDesktopBackgroundContentUrl(path: string): string {
  return `${NEURAL_LABS_API_PREFIX}/files/content?path=${encodeURIComponent(
    path
  )}`;
}

function getCustomDesktopBackgroundFilename(file: File): string {
  const extensionMatch = file.name.match(/(\.[a-zA-Z0-9]+)$/);
  const extension =
    extensionMatch?.[1]?.toLowerCase() ||
    (() => {
      const mimeExtension = file.type.split("/")[1];
      return mimeExtension ? `.${mimeExtension.toLowerCase()}` : ".png";
    })();

  return `custom-background${extension}`;
}
const TEXT_PREVIEW_EXTENSIONS = new Set([
  ".txt",
  ".toml",
  ".py",
  ".log",
  ".md",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".ini",
  ".cfg",
  ".conf",
  ".csv",
  ".sql",
  ".sh",
  ".env",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
]);
const TEXT_PREVIEW_MIME_TYPES = new Set([
  "application/json",
  "application/jsonl",
  "application/ndjson",
  "application/x-ndjson",
  "application/toml",
  "application/x-toml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/x-javascript",
]);
const TEXT_PREVIEW_FILENAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
]);
const PDF_PREVIEW_EXTENSIONS = new Set([".pdf"]);
const PDF_PREVIEW_MIME_TYPES = new Set(["application/pdf"]);
const KMZ_PREVIEW_EXTENSIONS = new Set([".kmz"]);
const KMZ_PREVIEW_MIME_TYPES = new Set(["application/vnd.google-earth.kmz"]);
const XLSX_PREVIEW_EXTENSIONS = new Set([".xlsx"]);
const XLSX_PREVIEW_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function createLocalId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getParentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function getAncestorPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  return ancestors;
}

function createDefaultDesktopExplorerState(): DesktopExplorerState {
  return {
    current_path: "",
    back_history: [],
    forward_history: [],
    selected_paths: [],
    anchor_path: null,
    view_mode: "icon",
  };
}

function createDefaultDesktopTerminalWindowState(): DesktopTerminalWindowState {
  return {
    layout: null,
    is_initializing: true,
  };
}

function createScratchEditorTab(): DesktopEditorTabState {
  return {
    tab_id: createLocalId(),
    path: null,
    name: "untitled.txt",
    mime_type: "text/plain",
    content: "",
    saved_content: "",
    is_loading: false,
    is_saving: false,
    error_message: null,
    last_saved_at: null,
  };
}

function createDefaultDesktopEditorWindowState(): DesktopEditorWindowState {
  const initialTab = createScratchEditorTab();
  return {
    tabs: [initialTab],
    active_tab_id: initialTab.tab_id,
    is_sidebar_open: true,
  };
}

function replacePathPrefix(
  targetPath: string,
  sourcePath: string,
  nextPath: string
): string {
  if (targetPath === sourcePath) {
    return nextPath;
  }
  if (!targetPath.startsWith(`${sourcePath}/`)) {
    return targetPath;
  }
  return `${nextPath}${targetPath.slice(sourcePath.length)}`;
}

function getPreviewKind(entry: NeuralLabsFileEntry): PreviewKind | null {
  const lowerName = entry.name.toLowerCase();
  const mimeType = entry.mime_type?.toLowerCase() ?? "";
  const extension = lowerName.includes(".")
    ? `.${lowerName.split(".").pop()}`
    : "";

  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (
    mimeType === "text/html" ||
    lowerName.endsWith(".html") ||
    lowerName.endsWith(".htm")
  ) {
    return "html";
  }
  if (
    PDF_PREVIEW_MIME_TYPES.has(mimeType) ||
    PDF_PREVIEW_EXTENSIONS.has(extension)
  ) {
    return "pdf";
  }
  if (
    KMZ_PREVIEW_MIME_TYPES.has(mimeType) ||
    KMZ_PREVIEW_EXTENSIONS.has(extension)
  ) {
    return "kmz";
  }
  if (
    XLSX_PREVIEW_MIME_TYPES.has(mimeType) ||
    XLSX_PREVIEW_EXTENSIONS.has(extension)
  ) {
    return "xlsx";
  }

  return null;
}

function isTextEditorEntry(entry: NeuralLabsFileEntry): boolean {
  const lowerName = entry.name.toLowerCase();
  const mimeType = entry.mime_type?.toLowerCase() ?? "";
  const extension = lowerName.includes(".")
    ? `.${lowerName.split(".").pop()}`
    : "";

  if (mimeType.startsWith("text/") || TEXT_PREVIEW_MIME_TYPES.has(mimeType)) {
    return true;
  }

  if (TEXT_PREVIEW_EXTENSIONS.has(extension)) {
    return true;
  }
  if (TEXT_PREVIEW_FILENAMES.has(lowerName)) {
    return true;
  }

  return false;
}

function isPreviewable(entry: NeuralLabsFileEntry): boolean {
  return isTextEditorEntry(entry) || getPreviewKind(entry) !== null;
}

function triggerBrowserDownload(path: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = `${NEURAL_LABS_API_PREFIX}/files/download?path=${encodeURIComponent(
    path
  )}`;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function getResponseErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.message === "string") {
    return candidate.message;
  }
  if (typeof candidate.detail === "string") {
    return candidate.detail;
  }
  if (typeof candidate.error_code === "string") {
    return candidate.error_code;
  }
  return null;
}

async function getFetchErrorMessage(response: Response): Promise<string> {
  try {
    const payload = await response.json();
    const message = getResponseErrorMessage(payload);
    if (message) {
      return message;
    }
  } catch {
    // Ignore parse issues and fall back to status text.
  }

  if (response.statusText) {
    return response.statusText;
  }
  return `Request failed (${response.status})`;
}

async function deleteTerminalById(terminalId: string): Promise<void> {
  const response = await fetch(
    `${NEURAL_LABS_API_PREFIX}/terminals/${encodeURIComponent(terminalId)}`,
    { method: "DELETE" }
  );

  if (response.status === 404 || response.status === 204) {
    return;
  }

  if (!response.ok) {
    throw new Error(await getFetchErrorMessage(response));
  }
}

function createTabFromTerminal(
  terminalId: string,
  existingTabs: TerminalTabState[],
  title?: string
): TerminalTabState {
  const tabId = createLocalId();
  const paneId = createLocalId();
  return {
    tab_id: tabId,
    title: title || `Terminal ${existingTabs.length + 1}`,
    split_mode: "none",
    panes: [{ pane_id: paneId, terminal_id: terminalId }],
    active_pane_id: paneId,
  };
}

function uniqueTerminalIds(layout: TerminalLayoutState): Set<string> {
  const ids = new Set<string>();
  layout.tabs.forEach((tab) => {
    tab.panes.forEach((pane) => ids.add(pane.terminal_id));
  });
  return ids;
}

function getTerminalIdsFromLayout(
  layout: TerminalLayoutState | null
): string[] {
  if (!layout) {
    return [];
  }

  return Array.from(uniqueTerminalIds(layout));
}

function reconcileLayout(
  savedLayout: PersistedTerminalLayout | null,
  terminalIds: string[]
): TerminalLayoutState {
  const available = new Set(terminalIds);
  const used = new Set<string>();
  const reconciledTabs: TerminalTabState[] = [];

  if (savedLayout) {
    for (const savedTab of savedLayout.tabs) {
      const panes = savedTab.panes.filter((pane) =>
        available.has(pane.terminal_id)
      );
      if (panes.length === 0) {
        continue;
      }

      panes.forEach((pane) => used.add(pane.terminal_id));
      const splitMode: SplitMode =
        panes.length === 2 ? savedTab.split_mode : "none";
      const activePaneId = panes.some(
        (pane) => pane.pane_id === savedTab.active_pane_id
      )
        ? savedTab.active_pane_id
        : panes[0]!.pane_id;

      reconciledTabs.push({
        ...savedTab,
        split_mode: splitMode,
        panes,
        active_pane_id: activePaneId,
      });
    }
  }

  for (const terminalId of terminalIds) {
    if (!used.has(terminalId)) {
      reconciledTabs.push(createTabFromTerminal(terminalId, reconciledTabs));
    }
  }

  if (reconciledTabs.length === 0 && terminalIds.length > 0) {
    reconciledTabs.push(createTabFromTerminal(terminalIds[0]!, []));
  }

  const activeTabId =
    savedLayout &&
    reconciledTabs.some((tab) => tab.tab_id === savedLayout.active_tab_id)
      ? savedLayout.active_tab_id
      : reconciledTabs[0]?.tab_id;

  return {
    tabs: reconciledTabs,
    active_tab_id: activeTabId ?? "",
  };
}

function loadPersistedLayout(): PersistedTerminalLayout | null {
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as PersistedTerminalLayout;
    if (
      !Array.isArray(parsed.tabs) ||
      typeof parsed.active_tab_id !== "string"
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function persistLayout(layout: TerminalLayoutState): void {
  const payload: PersistedTerminalLayout = {
    tabs: layout.tabs,
    active_tab_id: layout.active_tab_id,
  };
  window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload));
}

function loadPersistedTreeState(): PersistedTreeState | null {
  try {
    const raw = window.localStorage.getItem(TREE_STATE_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as PersistedTreeState;
    if (!Array.isArray(parsed.expanded_paths)) {
      return null;
    }

    return {
      current_path:
        typeof parsed.current_path === "string" ? parsed.current_path : "",
      expanded_paths: parsed.expanded_paths.filter(
        (path) => typeof path === "string"
      ),
      selected_path:
        typeof parsed.selected_path === "string" ? parsed.selected_path : null,
    };
  } catch {
    return null;
  }
}

function persistTreeState(state: PersistedTreeState): void {
  window.localStorage.setItem(TREE_STATE_STORAGE_KEY, JSON.stringify(state));
}

function loadPersistedPreviewWindows(): PreviewWindowState[] {
  try {
    const raw = window.localStorage.getItem(PREVIEW_WINDOWS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((entry): entry is PreviewWindowState => {
        if (!entry || typeof entry !== "object") {
          return false;
        }

        const candidate = entry as Record<string, unknown>;
        return (
          typeof candidate.id === "string" &&
          typeof candidate.path === "string" &&
          typeof candidate.name === "string" &&
          typeof candidate.x === "number" &&
          typeof candidate.y === "number" &&
          typeof candidate.width === "number" &&
          typeof candidate.height === "number" &&
          typeof candidate.z_index === "number" &&
          (candidate.preview_kind === "image" ||
            candidate.preview_kind === "html" ||
            candidate.preview_kind === "text" ||
            candidate.preview_kind === "pdf" ||
            candidate.preview_kind === "kmz" ||
            candidate.preview_kind === "xlsx") &&
          (candidate.snapped_zone === null ||
            typeof candidate.snapped_zone === "string") &&
          (candidate.is_maximized === undefined ||
            typeof candidate.is_maximized === "boolean") &&
          (candidate.is_minimized === undefined ||
            typeof candidate.is_minimized === "boolean") &&
          (candidate.restore_bounds === undefined ||
            candidate.restore_bounds === null ||
            (typeof candidate.restore_bounds === "object" &&
              candidate.restore_bounds !== null &&
              typeof (candidate.restore_bounds as Record<string, unknown>).x ===
                "number" &&
              typeof (candidate.restore_bounds as Record<string, unknown>).y ===
                "number" &&
              typeof (candidate.restore_bounds as Record<string, unknown>)
                .width === "number" &&
              typeof (candidate.restore_bounds as Record<string, unknown>)
                .height === "number" &&
              ((candidate.restore_bounds as Record<string, unknown>)
                .snapped_zone === null ||
                typeof (candidate.restore_bounds as Record<string, unknown>)
                  .snapped_zone === "string")))
        );
      })
      .map((entry) => ({
        ...entry,
        is_maximized: entry.is_maximized ?? false,
        is_minimized: entry.is_minimized ?? false,
        restore_bounds: entry.restore_bounds ?? null,
      }));
  } catch {
    return [];
  }
}

function persistPreviewWindows(windows: PreviewWindowState[]): void {
  window.localStorage.setItem(
    PREVIEW_WINDOWS_STORAGE_KEY,
    JSON.stringify(windows)
  );
}

function findTabIdForTerminal(
  layout: TerminalLayoutState,
  terminalId: string | null | undefined
): string | null {
  if (!terminalId) {
    return null;
  }

  for (const tab of layout.tabs) {
    if (tab.panes.some((pane) => pane.terminal_id === terminalId)) {
      return tab.tab_id;
    }
  }

  return null;
}

function TerminalPane({ terminalId, isActive, onFocus }: TerminalPaneProps) {
  const { resolvedTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const inputBufferRef = useRef("");
  const inputFlushTimerRef = useRef<number | null>(null);
  const receivedOutputRef = useRef(false);
  const bootstrapTimerRef = useRef<number | null>(null);
  const selectionCopyTimerRef = useRef<number | null>(null);

  const sendTerminalInput = useCallback(
    async (data: string) => {
      if (!data) {
        return;
      }

      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        return;
      }

      await fetch(`${NEURAL_LABS_API_PREFIX}/terminal/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ terminal_id: terminalId, data }),
      });
    },
    [terminalId]
  );

  const flushTerminalInput = useCallback(async () => {
    const data = inputBufferRef.current;
    inputBufferRef.current = "";
    if (!data) {
      return;
    }
    await sendTerminalInput(data);
  }, [sendTerminalInput]);

  const copyTerminalSelection = useCallback(async () => {
    const selection = terminalRef.current?.getSelection() ?? "";
    if (!selection) {
      return;
    }

    try {
      await navigator.clipboard.writeText(selection);
    } catch {
      // Ignore clipboard failures so terminal selection still works normally.
    }
  }, []);

  const pasteClipboardText = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        return;
      }
      await sendTerminalInput(text);
    } catch {
      // Ignore clipboard failures to avoid noisy terminal output.
    }
  }, [sendTerminalInput]);

  const terminalTheme = useMemo(
    () =>
      resolvedTheme === "dark"
        ? {
            background: "#0b0d12",
            foreground: "#f8fafc",
            cursor: "#f8fafc",
            cursorAccent: "#0b0d12",
            selectionBackground: "rgba(148, 163, 184, 0.28)",
          }
        : {
            background: "#fcfdff",
            foreground: "#0f172a",
            cursor: "#0f172a",
            cursorAccent: "#fcfdff",
            selectionBackground: "rgba(59, 130, 246, 0.22)",
          },
    [resolvedTheme]
  );

  const resizeTerminal = useCallback(async () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const host = hostRef.current;
    if (!terminal || !fitAddon || !host) {
      return;
    }

    if (host.clientWidth < 20 || host.clientHeight < 20) {
      return;
    }

    fitAddon.fit();

    if (terminal.cols <= 1 || terminal.rows <= 1) {
      return;
    }

    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        })
      );
      return;
    }

    await fetch(`${NEURAL_LABS_API_PREFIX}/terminal/resize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        terminal_id: terminalId,
        cols: terminal.cols,
        rows: terminal.rows,
      }),
    });
  }, [terminalId]);

  useEffect(() => {
    const terminalHost = hostRef.current;
    if (!terminalHost) {
      return;
    }

    // Clear any previous xterm DOM in case React reuses the host during refresh
    // or a terminal instance is replaced in-place.
    terminalHost.replaceChildren();

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
      theme: terminalTheme,
      allowProposedApi: false,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalHost);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    receivedOutputRef.current = false;
    terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      if (event.type !== "keydown") {
        return true;
      }

      const usesModifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (usesModifier && event.shiftKey && key === "c") {
        event.preventDefault();
        void copyTerminalSelection();
        return false;
      }
      if (usesModifier && key === "v") {
        event.preventDefault();
        void pasteClipboardText();
        return false;
      }
      return true;
    });

    let isDisposed = false;
    const connectSocket = async () => {
      try {
        const tokenResponse = await fetch(
          `${NEURAL_LABS_API_PREFIX}/terminal/ws-token`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ terminal_id: terminalId }),
          }
        );

        if (!tokenResponse.ok) {
          throw new Error(await getFetchErrorMessage(tokenResponse));
        }

        const tokenPayload =
          (await tokenResponse.json()) as TerminalWebSocketTokenResponse;
        if (isDisposed) {
          return;
        }

        const wsScheme = window.location.protocol === "https:" ? "wss" : "ws";
        const wsPath =
          tokenPayload.ws_path ||
          `${NEURAL_LABS_TERMINAL_WS_PATH}?token=${encodeURIComponent(
            tokenPayload.token
          )}`;
        const socket = new WebSocket(
          `${wsScheme}://${window.location.host}${wsPath}`
        );
        socketRef.current = socket;

        socket.onmessage = (event) => {
          if (isDisposed) {
            return;
          }

          if (typeof event.data !== "string") {
            return;
          }

          try {
            const payload = JSON.parse(event.data) as {
              type?: string;
              data?: string;
              code?: number;
            };
            if (payload.type === "output") {
              if (payload.data && payload.data.length > 0) {
                receivedOutputRef.current = true;
              }
              terminal.write(payload.data ?? "");
              return;
            }
            if (payload.type === "exit") {
              terminal.writeln(
                `\r\n[terminal exited${
                  typeof payload.code === "number"
                    ? ` with code ${payload.code}`
                    : ""
                }]`
              );
            }
          } catch {
            // Ignore malformed socket messages.
          }
        };

        socket.onerror = () => {
          if (!isDisposed) {
            terminal.writeln("\r\n[terminal stream error]");
          }
        };

        socket.onclose = () => {
          if (!isDisposed) {
            terminal.writeln("\r\n[terminal stream disconnected]");
          }
        };
      } catch (error) {
        if (!isDisposed) {
          terminal.writeln(
            `\r\n[terminal stream failed: ${
              error instanceof Error ? error.message : "Unknown error"
            }]`
          );
        }
      }
    };

    void connectSocket();

    bootstrapTimerRef.current = window.setTimeout(() => {
      if (!receivedOutputRef.current) {
        void sendTerminalInput("\n");
      }
    }, 1500);

    const inputSubscription = terminal.onData((data) => {
      inputBufferRef.current += data;
      if (inputFlushTimerRef.current !== null) {
        return;
      }

      inputFlushTimerRef.current = window.setTimeout(() => {
        inputFlushTimerRef.current = null;
        void flushTerminalInput();
      }, 25);
    });

    const selectionSubscription = terminal.onSelectionChange(() => {
      if (selectionCopyTimerRef.current !== null) {
        window.clearTimeout(selectionCopyTimerRef.current);
      }

      selectionCopyTimerRef.current = window.setTimeout(() => {
        selectionCopyTimerRef.current = null;
        if (terminal.hasSelection()) {
          void copyTerminalSelection();
        }
      }, 120);
    });

    const handleWindowResize = () => {
      void resizeTerminal();
    };

    const resizeObserver = new ResizeObserver(() => {
      void resizeTerminal();
    });
    resizeObserver.observe(terminalHost);
    resizeObserverRef.current = resizeObserver;
    window.addEventListener("resize", handleWindowResize);

    void resizeTerminal();

    return () => {
      isDisposed = true;
      inputSubscription.dispose();
      selectionSubscription.dispose();
      window.removeEventListener("resize", handleWindowResize);

      if (inputFlushTimerRef.current !== null) {
        window.clearTimeout(inputFlushTimerRef.current);
        inputFlushTimerRef.current = null;
      }
      if (bootstrapTimerRef.current !== null) {
        window.clearTimeout(bootstrapTimerRef.current);
        bootstrapTimerRef.current = null;
      }
      if (selectionCopyTimerRef.current !== null) {
        window.clearTimeout(selectionCopyTimerRef.current);
        selectionCopyTimerRef.current = null;
      }
      if (inputBufferRef.current.length > 0) {
        void flushTerminalInput();
      }

      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;

      socketRef.current?.close();
      socketRef.current = null;

      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminalHost.replaceChildren();
    };
  }, [
    copyTerminalSelection,
    flushTerminalInput,
    pasteClipboardText,
    resizeTerminal,
    sendTerminalInput,
    terminalId,
    terminalTheme,
  ]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const timer = window.setTimeout(() => {
      void resizeTerminal();
    }, 40);

    return () => window.clearTimeout(timer);
  }, [isActive, resizeTerminal]);

  return (
    <div
      className="h-full w-full"
      onMouseDown={onFocus}
      onFocus={onFocus}
      role="button"
      tabIndex={0}
    >
      <div
        ref={hostRef}
        className="h-full w-full bg-[#fcfdff] p-1.5 dark:bg-[#0b0d12]"
      />
    </div>
  );
}

function NeuralAppsPanel({
  onActivateTextEditor,
}: {
  onActivateTextEditor: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border-01 bg-background-neutral-01">
      <div className="flex items-center justify-between gap-2 border-b border-border-01 px-3 py-2">
        <Text mainUiAction>Neural Apps</Text>
      </div>

      <div className="default-scrollbar min-h-0 flex-1 overflow-auto p-2">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-10 border border-border-01 bg-background-neutral-02 px-3 py-2 text-left transition-colors hover:bg-background-neutral-00"
          onClick={onActivateTextEditor}
        >
          <SvgFileText className="h-4 w-4 shrink-0 stroke-text-03" />
          <Text className="truncate">Text Editor</Text>
        </button>
      </div>
    </div>
  );
}

function NeuralLabsFileExplorerPanel({
  currentPath,
  pathLabel,
  treeEntries,
  expandedPaths,
  loadingPaths,
  selectedPath,
  isPreviewable,
  fileUploadInputRef,
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
  onUploadInputChange,
  onNavigateUp,
  onCreateFolder,
  onRefreshDirectory,
  onTriggerUpload,
  onActivateTextEditor,
  showNeuralAppsPanel = false,
  className = "",
}: {
  currentPath: string;
  pathLabel: string;
  treeEntries: Record<string, NeuralLabsFileEntry[]>;
  expandedPaths: string[];
  loadingPaths: string[];
  selectedPath: string | null;
  isPreviewable: (entry: NeuralLabsFileEntry) => boolean;
  fileUploadInputRef: RefObject<HTMLInputElement | null>;
  onSelectEntry: (entry: NeuralLabsFileEntry) => void;
  onToggleDirectory: (entry: NeuralLabsFileEntry) => void;
  onActivateEntry: (entry: NeuralLabsFileEntry) => void;
  onPreviewEntry: (entry: NeuralLabsFileEntry) => void;
  onDownloadEntry: (entry: NeuralLabsFileEntry) => void;
  onCopyPath: (entry: NeuralLabsFileEntry) => void;
  onRenameEntry: (entry: NeuralLabsFileEntry) => void;
  onDeleteEntry: (entry: NeuralLabsFileEntry) => void;
  onMoveEntry: (entry: NeuralLabsFileEntry, destinationPath: string) => void;
  onUploadFiles: (
    files: File[],
    destinationPath: string
  ) => Promise<void> | void;
  onUploadInputChange: (
    event: ChangeEvent<HTMLInputElement>
  ) => Promise<void> | void;
  onNavigateUp: () => Promise<void> | void;
  onCreateFolder: () => Promise<void> | void;
  onRefreshDirectory: () => Promise<void> | void;
  onTriggerUpload: () => void;
  onActivateTextEditor: () => void;
  showNeuralAppsPanel?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col bg-background-neutral-02 ${className}`}
    >
      <div className="border-b border-border-01 bg-background-neutral-01 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-2">
            <SvgFolder className="h-4 w-4 shrink-0 stroke-text-03" />
            <Text mainUiAction>File Explorer</Text>
          </div>
          <Text
            className="truncate max-w-[14rem] md:max-w-[18rem]"
            text03
            title={pathLabel}
          >
            {pathLabel}
          </Text>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button
            tertiary
            size="md"
            leftIcon={SvgChevronLeft}
            disabled={!currentPath}
            onClick={() => void onNavigateUp()}
          >
            Up
          </Button>
          <div className="flex items-center gap-1.5">
            <IconActionButton label="New folder">
              <Button
                tertiary
                size="md"
                leftIcon={SvgFolderPlus}
                aria-label="New folder"
                onClick={() => void onCreateFolder()}
              />
            </IconActionButton>
            <IconActionButton label="Upload files">
              <Button
                tertiary
                size="md"
                leftIcon={SvgUploadCloud}
                aria-label="Upload files"
                onClick={onTriggerUpload}
              />
            </IconActionButton>
            <IconActionButton label="Refresh files">
              <Button
                tertiary
                size="md"
                leftIcon={SvgRefreshCw}
                aria-label="Refresh files"
                onClick={() => void onRefreshDirectory()}
              />
            </IconActionButton>
          </div>
        </div>
      </div>

      <input
        ref={fileUploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          void onUploadInputChange(event);
        }}
      />

      <div className="min-h-0 flex flex-1 flex-col">
        <div className="default-scrollbar min-h-0 flex-1 overflow-auto p-2">
          <NeuralLabsFileTree
            entriesByPath={treeEntries}
            expandedPaths={expandedPaths}
            loadingPaths={loadingPaths}
            selectedPath={selectedPath}
            onSelectEntry={onSelectEntry}
            onToggleDirectory={onToggleDirectory}
            onActivateEntry={onActivateEntry}
            onPreviewEntry={onPreviewEntry}
            onDownloadEntry={onDownloadEntry}
            onCopyPath={onCopyPath}
            onRenameEntry={onRenameEntry}
            onDeleteEntry={onDeleteEntry}
            onMoveEntry={onMoveEntry}
            onUploadFiles={onUploadFiles}
            canPreviewEntry={isPreviewable}
          />
        </div>

        {showNeuralAppsPanel ? (
          <div className="min-h-[18rem]">
            <NeuralAppsPanel onActivateTextEditor={onActivateTextEditor} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NeuralLabsTerminalWorkspacePanel({
  layout,
  activeTab,
  activePane,
  isInitializingTerminals,
  environmentStatus,
  canSplitActiveTab,
  onAddTab,
  onSplitActiveTab,
  onSetActiveTab,
  onSetActivePane,
  onCloseTabById,
  onClosePaneById,
  isTerminalNavigatorVisible = true,
  onCollapseTerminalNavigator,
  overlayChildren,
}: {
  layout: TerminalLayoutState | null;
  activeTab: TerminalTabState | null;
  activePane: TerminalPaneState | null;
  isInitializingTerminals: boolean;
  environmentStatus: { label: string; dotClass: string };
  canSplitActiveTab: boolean;
  onAddTab: () => Promise<void> | void;
  onSplitActiveTab: (
    direction: "horizontal" | "vertical"
  ) => Promise<void> | void;
  onSetActiveTab: (tabId: string) => void;
  onSetActivePane: (tabId: string, paneId: string) => void;
  onCloseTabById: (tabId: string) => Promise<void> | void;
  onClosePaneById: (tabId: string, paneId: string) => Promise<void> | void;
  isTerminalNavigatorVisible?: boolean;
  onCollapseTerminalNavigator?: () => void;
  overlayChildren?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background-neutral-02">
      <div className="flex items-center justify-between gap-2 border-b border-border-01 bg-background-neutral-01 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <SvgTerminal className="h-4 w-4 shrink-0 stroke-text-03" />
            <Text mainUiAction className="truncate">
              {activeTab
                ? activeTab.split_mode === "none"
                  ? `Terminal ${
                      layout?.tabs.findIndex(
                        (tab) => tab.tab_id === activeTab.tab_id
                      )! + 1
                    }`
                  : `Group ${
                      layout?.tabs.findIndex(
                        (tab) => tab.tab_id === activeTab.tab_id
                      )! + 1
                    }`
                : "Terminal Workspace"}
            </Text>
          </div>
          {activeTab ? (
            activeTab.split_mode !== "none" && activePane ? (
              <Text text03 className="truncate text-xs">
                {`Pane ${
                  activeTab.panes.findIndex(
                    (pane) => pane.pane_id === activePane.pane_id
                  ) + 1
                } · Terminal ${
                  activeTab.panes.findIndex(
                    (pane) => pane.pane_id === activePane.pane_id
                  ) + 1
                } active`}
              </Text>
            ) : activeTab.split_mode === "none" ? (
              <Text text03 className="truncate text-xs">
                {`Terminal ${
                  layout?.tabs.findIndex(
                    (tab) => tab.tab_id === activeTab.tab_id
                  )! + 1
                } active`}
              </Text>
            ) : null
          ) : (
            <Text text03 className="truncate text-xs">
              No active terminal
            </Text>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="hidden items-center gap-1 rounded-08 border border-border-01 px-2 py-1 md:flex">
            <span
              className={`h-2 w-2 rounded-full ${environmentStatus.dotClass}`}
            />
            <Text text03 className="whitespace-nowrap">
              {environmentStatus.label}
            </Text>
          </div>
          <Button tertiary size="md" onClick={() => void onAddTab()}>
            New Terminal
          </Button>
          <Button
            tertiary
            size="md"
            disabled={!canSplitActiveTab}
            onClick={() => void onSplitActiveTab("vertical")}
          >
            Split Vertical
          </Button>
          <Button
            tertiary
            size="md"
            disabled={!canSplitActiveTab}
            onClick={() => void onSplitActiveTab("horizontal")}
          >
            Split Horizontal
          </Button>
          {isTerminalNavigatorVisible && onCollapseTerminalNavigator ? (
            <IconActionButton label="Hide terminal navigator">
              <Button
                tertiary
                size="md"
                aria-label="Hide terminal navigator"
                onClick={onCollapseTerminalNavigator}
              >
                <SvgChevronRight className="h-4 w-4 stroke-text-03" />
              </Button>
            </IconActionButton>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex flex-1">
        <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
          {isInitializingTerminals ? (
            <div className="flex h-full w-full items-center justify-center p-3">
              <Text text03>Initializing terminals...</Text>
            </div>
          ) : !layout || layout.tabs.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center p-3">
              <Text text03>No terminal tabs available.</Text>
            </div>
          ) : (
            layout.tabs.map((tab) => {
              const isActiveTab = layout.active_tab_id === tab.tab_id;
              const splitClass =
                tab.split_mode === "vertical"
                  ? "grid grid-cols-1 md:grid-cols-2"
                  : tab.split_mode === "horizontal"
                    ? "grid grid-rows-2"
                    : "grid grid-cols-1";

              return (
                <div
                  key={tab.tab_id}
                  className={isActiveTab ? "h-full" : "hidden"}
                >
                  <div className={`h-full ${splitClass}`}>
                    {tab.panes.map((pane) => {
                      const isActivePane =
                        isActiveTab && tab.active_pane_id === pane.pane_id;

                      return (
                        <div
                          key={pane.pane_id}
                          className={`min-h-0 border border-border-01 ${
                            isActivePane ? "ring-1 ring-border-04" : "ring-0"
                          }`}
                          onMouseDown={() =>
                            onSetActivePane(tab.tab_id, pane.pane_id)
                          }
                        >
                          <TerminalPane
                            terminalId={pane.terminal_id}
                            isActive={isActivePane}
                            onFocus={() =>
                              onSetActivePane(tab.tab_id, pane.pane_id)
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
          {overlayChildren}
        </div>

        {isTerminalNavigatorVisible ? (
          <aside className="hidden w-[248px] shrink-0 border-l border-border-01 bg-background-neutral-01 md:flex md:flex-col">
            <div className="flex items-center justify-between border-b border-border-01 px-3 py-2">
              <Text mainUiAction>Terminal Navigator</Text>
              {onCollapseTerminalNavigator ? (
                <IconActionButton label="Collapse terminal navigator">
                  <Button
                    tertiary
                    size="md"
                    aria-label="Collapse terminal navigator"
                    onClick={onCollapseTerminalNavigator}
                  >
                    <SvgChevronRight className="h-4 w-4 stroke-text-03" />
                  </Button>
                </IconActionButton>
              ) : null}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              <div className="flex flex-col gap-2">
                {(layout?.tabs ?? []).map((tab, tabIndex) => {
                  const isActiveTab = layout?.active_tab_id === tab.tab_id;
                  const isGroupedTab = tab.panes.length > 1;
                  const paneLayoutClass =
                    tab.split_mode === "horizontal"
                      ? "grid grid-cols-2"
                      : "flex flex-col";

                  if (!isGroupedTab) {
                    const pane = tab.panes[0]!;
                    const isActivePane =
                      isActiveTab && tab.active_pane_id === pane.pane_id;

                    return (
                      <div
                        key={tab.tab_id}
                        className={`rounded-12 border ${
                          isActivePane
                            ? "border-border-04 bg-background-tint-03/60"
                            : "border-border-01 bg-background-neutral-02"
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-1 p-1.5">
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-10 px-2 py-1.5 text-left hover:bg-background-neutral-01/70"
                            onClick={() => {
                              onSetActiveTab(tab.tab_id);
                              onSetActivePane(tab.tab_id, pane.pane_id);
                            }}
                          >
                            <span
                              className={`h-2 w-2 shrink-0 rounded-full ${
                                isActivePane ? "bg-green-500" : "bg-border-03"
                              }`}
                            />
                            <Text className="min-w-0 truncate">
                              Terminal {tabIndex + 1}
                            </Text>
                          </button>
                          <IconActionButton label="Delete terminal">
                            <button
                              type="button"
                              className="flex h-7 w-7 items-center justify-center rounded-08 border border-border-01 bg-background-neutral-00 hover:bg-background-neutral-02"
                              aria-label="Delete terminal"
                              onClick={() =>
                                void onClosePaneById(tab.tab_id, pane.pane_id)
                              }
                            >
                              <SvgTrash className="h-4 w-4 stroke-red-500" />
                            </button>
                          </IconActionButton>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={tab.tab_id}
                      className={`rounded-12 border ${
                        isActiveTab
                          ? "border-border-04 bg-background-tint-03/60"
                          : "border-border-01 bg-background-neutral-02"
                      }`}
                    >
                      <div className="flex items-center gap-1 border-b border-border-01 px-1.5 py-1">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-08 px-1.5 py-1 text-left hover:bg-background-neutral-01/70"
                          onClick={() => onSetActiveTab(tab.tab_id)}
                        >
                          <SvgTerminal className="h-4 w-4 shrink-0 stroke-text-03" />
                          <Text className="truncate">Group {tabIndex + 1}</Text>
                        </button>
                        <IconActionButton label="Delete group">
                          <button
                            type="button"
                            className="flex h-7 w-7 items-center justify-center rounded-08 border border-border-01 bg-background-neutral-00 hover:bg-background-neutral-02"
                            aria-label="Delete group"
                            onClick={() => void onCloseTabById(tab.tab_id)}
                          >
                            <SvgTrash className="h-4 w-4 stroke-red-500" />
                          </button>
                        </IconActionButton>
                      </div>
                      <div className={`gap-1 p-1.5 ${paneLayoutClass}`}>
                        {tab.panes.map((pane, paneIndex) => {
                          const isActivePane =
                            isActiveTab && tab.active_pane_id === pane.pane_id;
                          return (
                            <div
                              key={pane.pane_id}
                              className={`flex min-w-0 items-center gap-1 rounded-10 border px-1.5 py-1 ${
                                isActivePane
                                  ? "border-border-04 bg-background-neutral-00"
                                  : "border-border-01 bg-background-neutral-01"
                              }`}
                            >
                              <button
                                type="button"
                                className="flex min-w-0 flex-1 items-center gap-2 rounded-08 px-1.5 py-1 text-left hover:bg-background-neutral-00/70"
                                onClick={() =>
                                  onSetActivePane(tab.tab_id, pane.pane_id)
                                }
                              >
                                <span
                                  className={`h-2 w-2 shrink-0 rounded-full ${
                                    isActivePane
                                      ? "bg-green-500"
                                      : "bg-border-03"
                                  }`}
                                />
                                <Text className="truncate">
                                  Terminal {paneIndex + 1}
                                </Text>
                              </button>
                              <IconActionButton label="Delete terminal">
                                <button
                                  type="button"
                                  className="flex h-7 w-7 items-center justify-center rounded-08 border border-border-01 bg-background-neutral-00 hover:bg-background-neutral-02"
                                  aria-label="Delete terminal"
                                  onClick={() =>
                                    void onClosePaneById(
                                      tab.tab_id,
                                      pane.pane_id
                                    )
                                  }
                                >
                                  <SvgTrash className="h-4 w-4 stroke-text-03" />
                                </button>
                              </IconActionButton>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function NeuralLabsDesktopSettingsPanel({
  selectedBackgroundId,
  customBackgroundPath,
  onSelectBackground,
  onSelectCustomBackground,
  onUploadCustomBackground,
  onDeleteCustomBackground,
  isUploadingCustomBackground,
  isDeletingCustomBackground,
}: {
  selectedBackgroundId: DesktopBackgroundSelection;
  customBackgroundPath: string | null;
  onSelectBackground: (backgroundId: DesktopBackgroundPresetId) => void;
  onSelectCustomBackground: () => void;
  onUploadCustomBackground: (file: File) => Promise<void> | void;
  onDeleteCustomBackground: () => Promise<void> | void;
  isUploadingCustomBackground: boolean;
  isDeletingCustomBackground: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { updateUserThemePreference } = useUser();
  const { theme, setTheme, systemTheme } = useTheme();
  const hasCustomBackground = Boolean(customBackgroundPath);
  const customBackgroundUrl = customBackgroundPath
    ? getDesktopBackgroundContentUrl(customBackgroundPath)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background-neutral-02">
      <div className="border-b border-border-01 bg-background-neutral-01 px-4 py-3">
        <Text mainUiAction>Desktop Settings</Text>
        <Text text03 className="mt-1">
          Choose a background for the Neural Labs desktop workspace.
        </Text>
      </div>

      <div className="default-scrollbar min-h-0 flex-1 overflow-auto p-4">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) {
              void onUploadCustomBackground(file);
            }
          }}
        />

        <div className="mb-4 rounded-16 border border-border-01 bg-background-neutral-01 px-4 py-3">
          <Text className="font-medium">Color mode</Text>
          <Text text03 className="mt-1 text-xs">
            Choose the light or dark theme for Neural Labs and the main app.
          </Text>
          <div className="mt-3">
            <InputSelect
              value={theme ?? ThemePreference.SYSTEM}
              onValueChange={(value) => {
                setTheme(value);
                void updateUserThemePreference(value as ThemePreference);
              }}
            >
              <InputSelect.Trigger />
              <InputSelect.Content>
                <InputSelect.Item
                  value={ThemePreference.SYSTEM}
                  icon={() => (
                    <ColorSwatch
                      light={systemTheme === "light"}
                      dark={systemTheme === "dark"}
                    />
                  )}
                  description={
                    systemTheme
                      ? systemTheme.charAt(0).toUpperCase() +
                        systemTheme.slice(1)
                      : undefined
                  }
                >
                  Auto
                </InputSelect.Item>
                <InputSelect.Separator />
                <InputSelect.Item
                  value={ThemePreference.LIGHT}
                  icon={() => <ColorSwatch light />}
                >
                  Light
                </InputSelect.Item>
                <InputSelect.Item
                  value={ThemePreference.DARK}
                  icon={() => <ColorSwatch dark />}
                >
                  Dark
                </InputSelect.Item>
              </InputSelect.Content>
            </InputSelect>
          </div>
        </div>

        <div className="mb-4 flex items-center justify-between gap-3 rounded-16 border border-border-01 bg-background-neutral-01 px-4 py-3">
          <div className="min-w-0">
            <Text className="font-medium">Custom background</Text>
            <Text text03 className="mt-1 text-xs">
              Upload an image into your Neural Labs workspace and reuse it here.
            </Text>
          </div>
          <Button
            tertiary
            size="md"
            leftIcon={SvgUploadCloud}
            disabled={isUploadingCustomBackground}
            onClick={() => fileInputRef.current?.click()}
          >
            {isUploadingCustomBackground ? "Uploading..." : "Upload"}
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {hasCustomBackground && customBackgroundUrl ? (
            <div className="relative">
              <button
                type="button"
                className={`w-full overflow-hidden rounded-16 border text-left transition ${
                  selectedBackgroundId.startsWith(
                    CUSTOM_DESKTOP_BACKGROUND_PREFIX
                  )
                    ? "border-border-04 bg-background-tint-03/40"
                    : "border-border-01 bg-background-neutral-01 hover:bg-background-neutral-00"
                }`}
                onClick={onSelectCustomBackground}
              >
                <div
                  className="h-28 w-full bg-cover bg-center"
                  style={{ backgroundImage: `url(${customBackgroundUrl})` }}
                />
                <div className="px-3 py-3">
                  <Text className="font-medium">Custom Upload</Text>
                </div>
              </button>
              <button
                type="button"
                className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white transition hover:bg-black/60 disabled:cursor-not-allowed disabled:opacity-60"
                aria-label="Delete uploaded background"
                disabled={isDeletingCustomBackground}
                onClick={(event) => {
                  event.stopPropagation();
                  void onDeleteCustomBackground();
                }}
              >
                <SvgTrash className="h-4 w-4 stroke-current" />
              </button>
            </div>
          ) : null}
          {DESKTOP_BACKGROUND_PRESETS.map((preset) => {
            const isSelected = preset.id === selectedBackgroundId;
            return (
              <button
                key={preset.id}
                type="button"
                className={`overflow-hidden rounded-16 border text-left transition ${
                  isSelected
                    ? "border-border-04 bg-background-tint-03/40"
                    : "border-border-01 bg-background-neutral-01 hover:bg-background-neutral-00"
                }`}
                onClick={() => onSelectBackground(preset.id)}
              >
                <div className={`h-28 w-full ${preset.previewClassName}`} />
                <div className="px-3 py-3">
                  <Text className="font-medium">{preset.name}</Text>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function NeuralLabsPage() {
  const router = useRouter();
  const hasLoadedUiMode = true;
  const [desktopBackgroundId, setDesktopBackgroundId] =
    useState<DesktopBackgroundSelection>("sunset-grid");
  const [desktopCustomBackgroundPath, setDesktopCustomBackgroundPath] =
    useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [treeEntries, setTreeEntries] = useState<
    Record<string, NeuralLabsFileEntry[]>
  >({});
  const [loadingPaths, setLoadingPaths] = useState<string[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewWindows, setPreviewWindows] = useState<PreviewWindowState[]>(
    []
  );
  const [desktopWindows, setDesktopWindows] = useState<DesktopWindowState[]>(
    []
  );
  const [desktopExplorerStates, setDesktopExplorerStates] = useState<
    Record<string, DesktopExplorerState>
  >({});
  const [desktopEditorStates, setDesktopEditorStates] = useState<
    Record<string, DesktopEditorWindowState>
  >({});
  const [desktopTerminalStates, setDesktopTerminalStates] = useState<
    Record<string, DesktopTerminalWindowState>
  >({});
  const [taskbarMenu, setTaskbarMenu] = useState<TaskbarMenuState | null>(null);
  const [workspaceBounds, setWorkspaceBounds] = useState({
    width: 0,
    height: 0,
  });
  const [layout, setLayout] = useState<TerminalLayoutState | null>(null);
  const [isInitializingTerminals, setIsInitializingTerminals] = useState(true);
  const [activeTerminalStatus, setActiveTerminalStatus] =
    useState<TerminalStatusResponse | null>(null);
  const [navigatorWidth, setNavigatorWidth] = useState(
    DEFAULT_NAVIGATOR_WIDTH_PX
  );
  const [isDesktopLayout, setIsDesktopLayout] = useState(false);
  const [isResizingNavigator, setIsResizingNavigator] = useState(false);
  const [isNavigatorCollapsed, setIsNavigatorCollapsed] = useState(false);
  const [isTerminalNavigatorCollapsed, setIsTerminalNavigatorCollapsed] =
    useState(false);
  const [isUploadingCustomBackground, setIsUploadingCustomBackground] =
    useState(false);
  const [isDeletingCustomBackground, setIsDeletingCustomBackground] =
    useState(false);

  const layoutRef = useRef<TerminalLayoutState | null>(null);
  const desktopEditorStatesRef = useRef<
    Record<string, DesktopEditorWindowState>
  >({});
  const desktopTerminalStatesRef = useRef<
    Record<string, DesktopTerminalWindowState>
  >({});
  const desktopTerminalInitInFlightRef = useRef(new Set<string>());
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);
  const previewWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const workspaceSplitRef = useRef<HTMLDivElement | null>(null);
  const highestPreviewZIndexRef = useRef(1);
  const treeSyncInFlightRef = useRef(false);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useEffect(() => {
    desktopEditorStatesRef.current = desktopEditorStates;
  }, [desktopEditorStates]);

  useEffect(() => {
    desktopTerminalStatesRef.current = desktopTerminalStates;
  }, [desktopTerminalStates]);

  useEffect(() => {
    const fileExplorerWindowIds = desktopWindows
      .filter((windowState) => windowState.app_kind === "file-explorer")
      .map((windowState) => windowState.id);
    if (fileExplorerWindowIds.length > 0) {
      setDesktopExplorerStates((previousStates) => {
        let didChange = false;
        const nextStates = { ...previousStates };
        fileExplorerWindowIds.forEach((windowId) => {
          if (!(windowId in nextStates)) {
            nextStates[windowId] = createDefaultDesktopExplorerState();
            didChange = true;
          }
        });
        return didChange ? nextStates : previousStates;
      });
    }

    const textEditorWindowIds = desktopWindows
      .filter((windowState) => windowState.app_kind === "text-editor")
      .map((windowState) => windowState.id);
    if (textEditorWindowIds.length > 0) {
      setDesktopEditorStates((previousStates) => {
        let didChange = false;
        const nextStates = { ...previousStates };
        textEditorWindowIds.forEach((windowId) => {
          if (!(windowId in nextStates)) {
            nextStates[windowId] = createDefaultDesktopEditorWindowState();
            didChange = true;
          }
        });
        return didChange ? nextStates : previousStates;
      });
    }

    const terminalWindowIds = desktopWindows
      .filter((windowState) => windowState.app_kind === "terminal-workspace")
      .map((windowState) => windowState.id);
    if (terminalWindowIds.length > 0) {
      setDesktopTerminalStates((previousStates) => {
        let didChange = false;
        const nextStates = { ...previousStates };
        terminalWindowIds.forEach((windowId) => {
          if (!(windowId in nextStates)) {
            nextStates[windowId] = createDefaultDesktopTerminalWindowState();
            didChange = true;
          }
        });
        return didChange ? nextStates : previousStates;
      });
    }
  }, [desktopWindows]);

  const clampNavigatorWidth = useCallback((candidateWidth: number) => {
    const splitWidth = workspaceSplitRef.current?.clientWidth ?? 0;
    const maxByContainer =
      splitWidth > 0
        ? Math.max(
            MIN_NAVIGATOR_WIDTH_PX,
            Math.floor(splitWidth * MAX_NAVIGATOR_WIDTH_RATIO)
          )
        : MAX_NAVIGATOR_WIDTH_PX;
    const maxWidth = Math.min(MAX_NAVIGATOR_WIDTH_PX, maxByContainer);
    return Math.min(Math.max(candidateWidth, MIN_NAVIGATOR_WIDTH_PX), maxWidth);
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 768px)");
    const syncLayoutMode = () => {
      setIsDesktopLayout(mediaQuery.matches);
    };
    syncLayoutMode();
    mediaQuery.addEventListener("change", syncLayoutMode);
    return () => {
      mediaQuery.removeEventListener("change", syncLayoutMode);
    };
  }, []);

  useEffect(() => {
    const raw = window.localStorage.getItem(DESKTOP_BACKGROUND_STORAGE_KEY);
    if (
      raw &&
      (isDesktopBackgroundPresetId(raw) ||
        raw.startsWith(CUSTOM_DESKTOP_BACKGROUND_PREFIX))
    ) {
      setDesktopBackgroundId(raw as DesktopBackgroundSelection);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      DESKTOP_BACKGROUND_STORAGE_KEY,
      desktopBackgroundId
    );
  }, [desktopBackgroundId]);

  useEffect(() => {
    const raw = window.localStorage.getItem(
      DESKTOP_CUSTOM_BACKGROUND_PATH_STORAGE_KEY
    );
    if (raw) {
      setDesktopCustomBackgroundPath(raw);
    }
  }, []);

  useEffect(() => {
    if (desktopCustomBackgroundPath) {
      window.localStorage.setItem(
        DESKTOP_CUSTOM_BACKGROUND_PATH_STORAGE_KEY,
        desktopCustomBackgroundPath
      );
      return;
    }

    window.localStorage.removeItem(DESKTOP_CUSTOM_BACKGROUND_PATH_STORAGE_KEY);
  }, [desktopCustomBackgroundPath]);

  useEffect(() => {
    if (!taskbarMenu) {
      return;
    }

    const clearMenu = () => setTaskbarMenu(null);
    window.addEventListener("click", clearMenu);
    window.addEventListener("contextmenu", clearMenu);

    return () => {
      window.removeEventListener("click", clearMenu);
      window.removeEventListener("contextmenu", clearMenu);
    };
  }, [taskbarMenu]);

  const isDesktopModeActive = true;

  useEffect(() => {
    const raw = window.localStorage.getItem(NAVIGATOR_WIDTH_STORAGE_KEY);
    if (!raw) {
      return;
    }

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      return;
    }

    setNavigatorWidth(clampNavigatorWidth(parsed));
  }, [clampNavigatorWidth]);

  useEffect(() => {
    window.localStorage.setItem(
      NAVIGATOR_WIDTH_STORAGE_KEY,
      `${Math.round(navigatorWidth)}`
    );
  }, [navigatorWidth]);

  useEffect(() => {
    const raw = window.localStorage.getItem(NAVIGATOR_COLLAPSED_STORAGE_KEY);
    if (raw === "1") {
      setIsNavigatorCollapsed(true);
    } else if (raw === "0") {
      setIsNavigatorCollapsed(false);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      NAVIGATOR_COLLAPSED_STORAGE_KEY,
      isNavigatorCollapsed ? "1" : "0"
    );
  }, [isNavigatorCollapsed]);

  const isNavigatorVisible = !isDesktopLayout || !isNavigatorCollapsed;

  useEffect(() => {
    const raw = window.localStorage.getItem(
      TERMINAL_NAVIGATOR_COLLAPSED_STORAGE_KEY
    );
    if (raw === "1") {
      setIsTerminalNavigatorCollapsed(true);
    } else if (raw === "0") {
      setIsTerminalNavigatorCollapsed(false);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      TERMINAL_NAVIGATOR_COLLAPSED_STORAGE_KEY,
      isTerminalNavigatorCollapsed ? "1" : "0"
    );
  }, [isTerminalNavigatorCollapsed]);

  const isTerminalNavigatorVisible =
    !isDesktopLayout || !isTerminalNavigatorCollapsed;

  useEffect(() => {
    if (!isDesktopLayout) {
      return;
    }

    const syncWidth = () => {
      setNavigatorWidth((previousWidth) => clampNavigatorWidth(previousWidth));
    };
    syncWidth();
    window.addEventListener("resize", syncWidth);
    return () => {
      window.removeEventListener("resize", syncWidth);
    };
  }, [clampNavigatorWidth, isDesktopLayout]);

  const beginResizeNavigator = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !isDesktopLayout || isNavigatorCollapsed) {
        return;
      }

      event.preventDefault();
      const splitNode = workspaceSplitRef.current;
      if (!splitNode) {
        return;
      }

      setIsResizingNavigator(true);
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const splitBounds = splitNode.getBoundingClientRect();
        const nextWidth = clampNavigatorWidth(
          moveEvent.clientX - splitBounds.left
        );
        setNavigatorWidth(nextWidth);
      };

      const stopResizing = () => {
        setIsResizingNavigator(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", stopResizing);
        window.removeEventListener("pointercancel", stopResizing);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", stopResizing);
      window.addEventListener("pointercancel", stopResizing);
    },
    [clampNavigatorWidth, isDesktopLayout, isNavigatorCollapsed]
  );

  const loadDirectory = useCallback(
    async (path: string, options?: DirectoryLoadOptions) => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setLoadingPaths((previousPaths) =>
          previousPaths.includes(path)
            ? previousPaths
            : [...previousPaths, path]
        );
      }
      try {
        const response = await fetch(
          `${NEURAL_LABS_API_PREFIX}/files?path=${encodeURIComponent(path)}`
        );
        if (!response.ok) {
          const errorMessage = await getFetchErrorMessage(response);
          if (response.status === 404) {
            setTreeEntries((previousTree) => {
              const nextTree = { ...previousTree };
              Object.keys(nextTree).forEach((treePath) => {
                if (treePath === path || treePath.startsWith(`${path}/`)) {
                  delete nextTree[treePath];
                }
              });
              return nextTree;
            });
            setExpandedPaths((previousPaths) =>
              previousPaths.filter(
                (candidatePath) =>
                  candidatePath !== path &&
                  !candidatePath.startsWith(`${path}/`)
              )
            );
            setCurrentPath((previousPath) =>
              previousPath === path ? getParentPath(path) : previousPath
            );
            setSelectedPath((previousPath) =>
              previousPath === path ? getParentPath(path) || null : previousPath
            );
            if (!silent) {
              toast.error(`Unable to load files: ${errorMessage}`);
            }
            return;
          }
          throw new Error(errorMessage);
        }

        const payload = (await response.json()) as DirectoryResponse;
        setTreeEntries((previousTree) => ({
          ...previousTree,
          [payload.path]: payload.entries,
        }));
      } catch (error) {
        if (!silent) {
          toast.error(
            `Unable to load files: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      } finally {
        if (!silent) {
          setLoadingPaths((previousPaths) =>
            previousPaths.filter((candidatePath) => candidatePath !== path)
          );
        }
      }
    },
    []
  );

  const refreshDirectory = useCallback(
    async (options?: DirectoryLoadOptions) => {
      const pathsToRefresh = new Set<string>(["", currentPath]);
      expandedPaths.forEach((path) => pathsToRefresh.add(path));

      await Promise.all(
        Array.from(pathsToRefresh)
          .filter((path) => path !== undefined)
          .map(async (path) => {
            await loadDirectory(path, options);
          })
      );
    },
    [currentPath, expandedPaths, loadDirectory]
  );

  const refreshDirectoryPaths = useCallback(
    async (paths: string[], options?: DirectoryLoadOptions) => {
      const uniquePaths = Array.from(new Set(["", ...paths])).filter(
        (path): path is string => typeof path === "string"
      );
      await Promise.all(
        uniquePaths.map(async (path) => {
          await loadDirectory(path, options);
        })
      );
    },
    [loadDirectory]
  );

  function openTextEditorApp(options?: { forceNew?: boolean }) {
    return openDesktopApp("text-editor", { forceNew: options?.forceNew });
  }

  const handleTextFileSaved = useCallback(
    async (targetPath: string) => {
      const parentPath = getParentPath(targetPath);
      const expandedAncestors = parentPath ? getAncestorPaths(parentPath) : [];

      setExpandedPaths((previousPaths) => {
        const nextPaths = new Set(previousPaths);
        expandedAncestors.forEach((path) => nextPaths.add(path));
        return Array.from(nextPaths);
      });
      setCurrentPath(parentPath);
      setSelectedPath(targetPath);
      await refreshDirectoryPaths([parentPath]);
    },
    [refreshDirectoryPaths]
  );

  function setActiveDesktopEditorTab(windowId: string, tabId: string) {
    updateDesktopEditorState(windowId, (currentState) => ({
      ...currentState,
      active_tab_id: tabId,
    }));
    focusDesktopWindow(windowId);
  }

  function toggleDesktopEditorSidebar(windowId: string) {
    updateDesktopEditorState(windowId, (currentState) => ({
      ...currentState,
      is_sidebar_open: !currentState.is_sidebar_open,
    }));
  }

  function addDesktopEditorScratchTab(windowId: string) {
    const nextTab = createScratchEditorTab();
    updateDesktopEditorState(windowId, (currentState) => ({
      ...currentState,
      tabs: [...currentState.tabs, nextTab],
      active_tab_id: nextTab.tab_id,
    }));
    focusDesktopWindow(windowId);
  }

  function updateDesktopEditorTabContent(
    windowId: string,
    tabId: string,
    content: string
  ) {
    updateDesktopEditorState(windowId, (currentState) => ({
      ...currentState,
      tabs: currentState.tabs.map((tab) =>
        tab.tab_id === tabId ? { ...tab, content, error_message: null } : tab
      ),
    }));
  }

  async function loadDesktopEditorTabContent(
    windowId: string,
    tabId: string,
    path: string
  ) {
    updateDesktopEditorState(windowId, (currentState) => ({
      ...currentState,
      tabs: currentState.tabs.map((tab) =>
        tab.tab_id === tabId
          ? { ...tab, is_loading: true, error_message: null }
          : tab
      ),
    }));

    try {
      const response = await fetch(
        `${NEURAL_LABS_API_PREFIX}/files/content?path=${encodeURIComponent(
          path
        )}`,
        {
          headers: { Accept: "text/plain" },
        }
      );
      if (!response.ok) {
        throw new Error(await getFetchErrorMessage(response));
      }

      const content = await response.text();
      updateDesktopEditorState(windowId, (currentState) => ({
        ...currentState,
        tabs: currentState.tabs.map((tab) =>
          tab.tab_id === tabId
            ? {
                ...tab,
                content,
                saved_content: content,
                is_loading: false,
                error_message: null,
              }
            : tab
        ),
      }));
    } catch (error) {
      updateDesktopEditorState(windowId, (currentState) => ({
        ...currentState,
        tabs: currentState.tabs.map((tab) =>
          tab.tab_id === tabId
            ? {
                ...tab,
                is_loading: false,
                error_message:
                  error instanceof Error
                    ? error.message
                    : "Unable to load file",
              }
            : tab
        ),
      }));
    }
  }

  function openTextFileInEditor(
    entry: NeuralLabsFileEntry,
    options?: { preferredWindowId?: string }
  ) {
    for (const [windowId, windowState] of Object.entries(
      desktopEditorStatesRef.current
    )) {
      const existingTab = windowState.tabs.find(
        (tab) => tab.path === entry.path
      );
      if (existingTab) {
        setActiveDesktopEditorTab(windowId, existingTab.tab_id);
        return;
      }
    }

    const targetWindowId =
      options?.preferredWindowId &&
      desktopEditorStatesRef.current[options.preferredWindowId]
        ? options.preferredWindowId
        : openTextEditorApp();

    const nextTab: DesktopEditorTabState = {
      tab_id: createLocalId(),
      path: entry.path,
      name: entry.name,
      mime_type: entry.mime_type,
      content: "",
      saved_content: "",
      is_loading: true,
      is_saving: false,
      error_message: null,
      last_saved_at: null,
    };

    updateDesktopEditorState(targetWindowId, (currentState) => {
      const replaceScratch =
        currentState.tabs.length === 1 &&
        currentState.tabs[0]?.path === null &&
        currentState.tabs[0]?.content === "" &&
        currentState.tabs[0]?.saved_content === "";
      return {
        ...currentState,
        tabs: replaceScratch ? [nextTab] : [...currentState.tabs, nextTab],
        active_tab_id: nextTab.tab_id,
      };
    });
    focusDesktopWindow(targetWindowId);
    void loadDesktopEditorTabContent(
      targetWindowId,
      nextTab.tab_id,
      entry.path
    );
  }

  const navigateUp = useCallback(async () => {
    if (!currentPath) {
      return;
    }

    const parentPath = getParentPath(currentPath);
    setCurrentPath(parentPath);
    setSelectedPath(parentPath || null);
    if (parentPath) {
      setExpandedPaths((previousPaths) =>
        previousPaths.includes(parentPath)
          ? previousPaths
          : [...previousPaths, parentPath]
      );
    }
    await loadDirectory(parentPath);
  }, [currentPath, loadDirectory]);

  const selectEntry = useCallback((entry: NeuralLabsFileEntry) => {
    setSelectedPath(entry.path);
    setCurrentPath(entry.is_directory ? entry.path : getParentPath(entry.path));
  }, []);

  const toggleDirectory = useCallback(
    (entry: NeuralLabsFileEntry) => {
      setSelectedPath(entry.path);
      setCurrentPath(entry.path);
      setExpandedPaths((previousPaths) => {
        if (previousPaths.includes(entry.path)) {
          return previousPaths.filter((path) => path !== entry.path);
        }
        return [...previousPaths, entry.path];
      });

      if (!treeEntries[entry.path]) {
        void loadDirectory(entry.path);
      }
    },
    [loadDirectory, treeEntries]
  );

  const focusPreviewWindow = useCallback((windowId: string) => {
    highestPreviewZIndexRef.current += 1;
    setPreviewWindows((previousWindows) =>
      previousWindows.map((windowState) =>
        windowState.id === windowId
          ? {
              ...windowState,
              is_minimized: false,
              z_index: highestPreviewZIndexRef.current,
            }
          : windowState
      )
    );
  }, []);

  const updatePreviewWindow = useCallback(
    (
      windowId: string,
      update:
        | Partial<PreviewWindowState>
        | ((windowState: PreviewWindowState) => PreviewWindowState)
    ) => {
      setPreviewWindows((previousWindows) =>
        previousWindows.map((windowState) => {
          if (windowState.id !== windowId) {
            return windowState;
          }

          if (typeof update === "function") {
            return update(windowState);
          }

          return { ...windowState, ...update };
        })
      );
    },
    []
  );

  const closePreviewWindow = useCallback((windowId: string) => {
    setPreviewWindows((previousWindows) =>
      previousWindows.filter((windowState) => windowState.id !== windowId)
    );
  }, []);

  const minimizePreviewWindow = useCallback((windowId: string) => {
    setPreviewWindows((previousWindows) =>
      previousWindows.map((windowState) =>
        windowState.id === windowId
          ? { ...windowState, is_minimized: true }
          : windowState
      )
    );
  }, []);

  const restorePreviewWindow = useCallback((windowId: string) => {
    highestPreviewZIndexRef.current += 1;
    setPreviewWindows((previousWindows) =>
      previousWindows.map((windowState) =>
        windowState.id === windowId
          ? {
              ...windowState,
              is_minimized: false,
              z_index: highestPreviewZIndexRef.current,
            }
          : windowState
      )
    );
  }, []);

  const focusDesktopWindow = useCallback((windowId: string) => {
    highestPreviewZIndexRef.current += 1;
    setDesktopWindows((previousWindows) =>
      previousWindows.map((windowState) =>
        windowState.id === windowId
          ? {
              ...windowState,
              is_minimized: false,
              z_index: highestPreviewZIndexRef.current,
            }
          : windowState
      )
    );
  }, []);

  const focusOrRestoreLatestTextEditor = useCallback(() => {
    const latestEditorWindow = [...desktopWindows]
      .filter((windowState) => windowState.app_kind === "text-editor")
      .sort((left, right) => right.z_index - left.z_index)[0];

    if (!latestEditorWindow) {
      openTextEditorApp();
      return;
    }

    focusDesktopWindow(latestEditorWindow.id);
  }, [desktopWindows, focusDesktopWindow]);

  function closeDesktopEditorTab(windowId: string, tabId: string) {
    updateDesktopEditorState(windowId, (currentState) => {
      const remainingTabs = currentState.tabs.filter(
        (tab) => tab.tab_id !== tabId
      );
      if (remainingTabs.length === 0) {
        const scratchTab = createScratchEditorTab();
        return {
          ...currentState,
          tabs: [scratchTab],
          active_tab_id: scratchTab.tab_id,
        };
      }

      const nextActiveTabId =
        currentState.active_tab_id === tabId
          ? remainingTabs[
              Math.max(
                0,
                currentState.tabs.findIndex((tab) => tab.tab_id === tabId) - 1
              )
            ]?.tab_id ?? remainingTabs[0]!.tab_id
          : currentState.active_tab_id;

      return {
        ...currentState,
        tabs: remainingTabs,
        active_tab_id: nextActiveTabId,
      };
    });
  }

  async function saveDesktopEditorTab(windowId: string, tabId: string) {
    const tab = desktopEditorStatesRef.current[windowId]?.tabs.find(
      (candidate) => candidate.tab_id === tabId
    );
    if (!tab) {
      return;
    }
    if (!tab.path) {
      throw new Error("Choose a file path before saving.");
    }

    updateDesktopEditorState(windowId, (currentState) => ({
      ...currentState,
      tabs: currentState.tabs.map((candidate) =>
        candidate.tab_id === tabId
          ? { ...candidate, is_saving: true, error_message: null }
          : candidate
      ),
    }));

    try {
      const response = await fetch(`${NEURAL_LABS_API_PREFIX}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: tab.path,
          content: tab.content,
        }),
      });

      if (!response.ok) {
        throw new Error(await getFetchErrorMessage(response));
      }

      updateDesktopEditorState(windowId, (currentState) => ({
        ...currentState,
        tabs: currentState.tabs.map((candidate) =>
          candidate.tab_id === tabId
            ? {
                ...candidate,
                saved_content: candidate.content,
                is_saving: false,
                error_message: null,
                last_saved_at: Date.now(),
              }
            : candidate
        ),
      }));
      await handleTextFileSaved(tab.path);
    } catch (error) {
      updateDesktopEditorState(windowId, (currentState) => ({
        ...currentState,
        tabs: currentState.tabs.map((candidate) =>
          candidate.tab_id === tabId
            ? {
                ...candidate,
                is_saving: false,
                error_message:
                  error instanceof Error
                    ? error.message
                    : "Unable to save file",
              }
            : candidate
        ),
      }));
      throw error;
    }
  }

  async function saveDesktopEditorTabAs(
    windowId: string,
    tabId: string,
    targetPath: string
  ) {
    const trimmedPath = targetPath.trim().replace(/^\/+/, "");
    if (!trimmedPath) {
      throw new Error("File name cannot be empty.");
    }

    updateDesktopEditorState(windowId, (currentState) => ({
      ...currentState,
      tabs: currentState.tabs.map((candidate) =>
        candidate.tab_id === tabId
          ? { ...candidate, is_saving: true, error_message: null }
          : candidate
      ),
    }));

    try {
      const tab = desktopEditorStatesRef.current[windowId]?.tabs.find(
        (candidate) => candidate.tab_id === tabId
      );
      if (!tab) {
        throw new Error("Unable to find the current editor tab.");
      }

      const response = await fetch(`${NEURAL_LABS_API_PREFIX}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: trimmedPath,
          content: tab.content,
        }),
      });

      if (!response.ok) {
        throw new Error(await getFetchErrorMessage(response));
      }

      updateDesktopEditorState(windowId, (currentState) => ({
        ...currentState,
        tabs: currentState.tabs.map((candidate) =>
          candidate.tab_id === tabId
            ? {
                ...candidate,
                path: trimmedPath,
                name: trimmedPath.split("/").pop() ?? trimmedPath,
                saved_content: candidate.content,
                is_saving: false,
                error_message: null,
                last_saved_at: Date.now(),
              }
            : candidate
        ),
      }));
      await handleTextFileSaved(trimmedPath);
    } catch (error) {
      updateDesktopEditorState(windowId, (currentState) => ({
        ...currentState,
        tabs: currentState.tabs.map((candidate) =>
          candidate.tab_id === tabId
            ? {
                ...candidate,
                is_saving: false,
                error_message:
                  error instanceof Error
                    ? error.message
                    : "Unable to save file",
              }
            : candidate
        ),
      }));
      throw error;
    }
  }

  async function reloadDesktopEditorTab(windowId: string, tabId: string) {
    const tab = desktopEditorStatesRef.current[windowId]?.tabs.find(
      (candidate) => candidate.tab_id === tabId
    );
    if (!tab?.path) {
      return;
    }

    await loadDesktopEditorTabContent(windowId, tabId, tab.path);
  }

  const updateDesktopWindow = useCallback(
    (
      windowId: string,
      update:
        | Partial<DesktopWindowState>
        | ((windowState: DesktopWindowState) => DesktopWindowState)
    ) => {
      setDesktopWindows((previousWindows) =>
        previousWindows.map((windowState) => {
          if (windowState.id !== windowId) {
            return windowState;
          }

          if (typeof update === "function") {
            return update(windowState);
          }

          return { ...windowState, ...update };
        })
      );
    },
    []
  );

  const removeDesktopWindowRecord = useCallback((windowId: string) => {
    setDesktopWindows((previousWindows) =>
      previousWindows.filter((windowState) => windowState.id !== windowId)
    );
    setDesktopExplorerStates((previousStates) => {
      if (!(windowId in previousStates)) {
        return previousStates;
      }
      const nextStates = { ...previousStates };
      delete nextStates[windowId];
      return nextStates;
    });
    setDesktopEditorStates((previousStates) => {
      if (!(windowId in previousStates)) {
        return previousStates;
      }
      const nextStates = { ...previousStates };
      delete nextStates[windowId];
      return nextStates;
    });
    setDesktopTerminalStates((previousStates) => {
      if (!(windowId in previousStates)) {
        return previousStates;
      }
      const nextStates = { ...previousStates };
      delete nextStates[windowId];
      return nextStates;
    });
  }, []);

  const updateDesktopEditorState = useCallback(
    (
      windowId: string,
      update:
        | Partial<DesktopEditorWindowState>
        | ((state: DesktopEditorWindowState) => DesktopEditorWindowState)
    ) => {
      setDesktopEditorStates((previousStates) => {
        const currentState = previousStates[windowId];
        if (!currentState) {
          return previousStates;
        }

        return {
          ...previousStates,
          [windowId]:
            typeof update === "function"
              ? update(currentState)
              : { ...currentState, ...update },
        };
      });
    },
    []
  );

  const updateDesktopTerminalState = useCallback(
    (
      windowId: string,
      update:
        | Partial<DesktopTerminalWindowState>
        | ((state: DesktopTerminalWindowState) => DesktopTerminalWindowState)
    ) => {
      setDesktopTerminalStates((previousStates) => {
        const currentState = previousStates[windowId];
        if (!currentState) {
          return previousStates;
        }

        return {
          ...previousStates,
          [windowId]:
            typeof update === "function"
              ? update(currentState)
              : { ...currentState, ...update },
        };
      });
    },
    []
  );

  const closeDesktopWindow = useCallback(
    (windowId: string) => {
      const editorState = desktopEditorStatesRef.current[windowId];
      if (
        editorState?.tabs.some((tab) => tab.content !== tab.saved_content) &&
        !window.confirm("Close this editor window and discard unsaved changes?")
      ) {
        return;
      }

      const terminalIds = getTerminalIdsFromLayout(
        desktopTerminalStatesRef.current[windowId]?.layout ?? null
      );

      removeDesktopWindowRecord(windowId);

      if (terminalIds.length === 0) {
        return;
      }

      void (async () => {
        for (const terminalId of terminalIds) {
          try {
            await deleteTerminalById(terminalId);
          } catch (error) {
            toast.error(
              `Failed closing terminal: ${
                error instanceof Error ? error.message : "Unknown error"
              }`
            );
          }
        }
      })();
    },
    [removeDesktopWindowRecord]
  );

  const minimizeDesktopWindow = useCallback((windowId: string) => {
    setDesktopWindows((previousWindows) =>
      previousWindows.map((windowState) =>
        windowState.id === windowId
          ? { ...windowState, is_minimized: true }
          : windowState
      )
    );
  }, []);

  const updateDesktopExplorerState = useCallback(
    (
      windowId: string,
      update:
        | Partial<DesktopExplorerState>
        | ((state: DesktopExplorerState) => DesktopExplorerState)
    ) => {
      setDesktopExplorerStates((previousStates) => {
        const currentState =
          previousStates[windowId] ?? createDefaultDesktopExplorerState();
        return {
          ...previousStates,
          [windowId]:
            typeof update === "function"
              ? update(currentState)
              : { ...currentState, ...update },
        };
      });
    },
    []
  );

  const setDesktopExplorerSelection = useCallback(
    (windowId: string, paths: string[], anchorPath: string | null) => {
      updateDesktopExplorerState(windowId, (currentState) => ({
        ...currentState,
        selected_paths: paths,
        anchor_path: anchorPath,
      }));
    },
    [updateDesktopExplorerState]
  );

  const navigateDesktopExplorerToPath = useCallback(
    async (
      windowId: string,
      nextPath: string,
      options?: { pushHistory?: boolean }
    ) => {
      const shouldPushHistory = options?.pushHistory ?? true;
      updateDesktopExplorerState(windowId, (currentState) => {
        if (currentState.current_path === nextPath) {
          return {
            ...currentState,
            selected_paths: [],
            anchor_path: null,
          };
        }

        return {
          ...currentState,
          current_path: nextPath,
          back_history:
            shouldPushHistory && currentState.current_path !== ""
              ? [...currentState.back_history, currentState.current_path]
              : shouldPushHistory
                ? [...currentState.back_history, currentState.current_path]
                : currentState.back_history,
          forward_history: shouldPushHistory
            ? []
            : currentState.forward_history,
          selected_paths: [],
          anchor_path: null,
        };
      });
      await loadDirectory(nextPath);
    },
    [loadDirectory, updateDesktopExplorerState]
  );

  const navigateDesktopExplorerBack = useCallback(
    async (windowId: string) => {
      const currentState = desktopExplorerStates[windowId];
      if (!currentState || currentState.back_history.length === 0) {
        return;
      }

      const previousPath =
        currentState.back_history[currentState.back_history.length - 1] ?? "";
      updateDesktopExplorerState(windowId, {
        current_path: previousPath,
        back_history: currentState.back_history.slice(0, -1),
        forward_history: [
          currentState.current_path,
          ...currentState.forward_history,
        ],
        selected_paths: [],
        anchor_path: null,
      });
      await loadDirectory(previousPath);
    },
    [desktopExplorerStates, loadDirectory, updateDesktopExplorerState]
  );

  const navigateDesktopExplorerForward = useCallback(
    async (windowId: string) => {
      const currentState = desktopExplorerStates[windowId];
      if (!currentState || currentState.forward_history.length === 0) {
        return;
      }

      const [nextPath, ...remainingForwardHistory] =
        currentState.forward_history;
      if (typeof nextPath !== "string") {
        return;
      }

      updateDesktopExplorerState(windowId, {
        current_path: nextPath,
        back_history: [...currentState.back_history, currentState.current_path],
        forward_history: remainingForwardHistory,
        selected_paths: [],
        anchor_path: null,
      });
      await loadDirectory(nextPath);
    },
    [desktopExplorerStates, loadDirectory, updateDesktopExplorerState]
  );

  const navigateDesktopExplorerUp = useCallback(
    async (windowId: string) => {
      const currentState = desktopExplorerStates[windowId];
      if (!currentState?.current_path) {
        return;
      }
      await navigateDesktopExplorerToPath(
        windowId,
        getParentPath(currentState.current_path)
      );
    },
    [desktopExplorerStates, navigateDesktopExplorerToPath]
  );

  const openDesktopApp = useCallback(
    (
      appKind: DesktopWindowState["app_kind"],
      options?: {
        forceNew?: boolean;
        initialTerminalState?: DesktopTerminalWindowState;
      }
    ): string => {
      const existingWindow = desktopWindows
        .filter((windowState) => windowState.app_kind === appKind)
        .sort((left, right) => right.z_index - left.z_index)[0];
      if (existingWindow && !options?.forceNew) {
        focusDesktopWindow(existingWindow.id);
        return existingWindow.id;
      }

      const existingWindowCount = desktopWindows.filter(
        (windowState) => windowState.app_kind === appKind
      ).length;

      highestPreviewZIndexRef.current += 1;
      const isFileExplorerApp = appKind === "file-explorer";
      const isSettingsApp = appKind === "desktop-settings";
      const isTextEditorApp = appKind === "text-editor";
      const width = isFileExplorerApp
        ? workspaceBounds.width > 0
          ? Math.min(
              DEFAULT_FILE_EXPLORER_WINDOW.width,
              Math.max(400, workspaceBounds.width * 0.34)
            )
          : DEFAULT_FILE_EXPLORER_WINDOW.width
        : isSettingsApp
          ? workspaceBounds.width > 0
            ? Math.min(
                DEFAULT_SETTINGS_WINDOW.width,
                Math.max(420, workspaceBounds.width * 0.38)
              )
            : DEFAULT_SETTINGS_WINDOW.width
          : isTextEditorApp
            ? workspaceBounds.width > 0
              ? Math.min(
                  DEFAULT_TEXT_EDITOR_WINDOW.width,
                  Math.max(820, workspaceBounds.width * 0.78)
                )
              : DEFAULT_TEXT_EDITOR_WINDOW.width
            : workspaceBounds.width > 0
              ? Math.min(
                  DEFAULT_TERMINAL_WINDOW.width,
                  Math.max(760, workspaceBounds.width * 0.72)
                )
              : DEFAULT_TERMINAL_WINDOW.width;
      const height = isFileExplorerApp
        ? workspaceBounds.height > 0
          ? Math.min(
              DEFAULT_FILE_EXPLORER_WINDOW.height,
              Math.max(460, workspaceBounds.height * 0.78)
            )
          : DEFAULT_FILE_EXPLORER_WINDOW.height
        : isSettingsApp
          ? workspaceBounds.height > 0
            ? Math.min(
                DEFAULT_SETTINGS_WINDOW.height,
                Math.max(340, workspaceBounds.height * 0.54)
              )
            : DEFAULT_SETTINGS_WINDOW.height
          : isTextEditorApp
            ? workspaceBounds.height > 0
              ? Math.min(
                  DEFAULT_TEXT_EDITOR_WINDOW.height,
                  Math.max(520, workspaceBounds.height * 0.82)
                )
              : DEFAULT_TEXT_EDITOR_WINDOW.height
            : workspaceBounds.height > 0
              ? Math.min(
                  DEFAULT_TERMINAL_WINDOW.height,
                  Math.max(520, workspaceBounds.height * 0.78)
                )
              : DEFAULT_TERMINAL_WINDOW.height;

      const existingOffset = existingWindowCount * 24;
      const windowId = createLocalId();

      if (isFileExplorerApp) {
        setDesktopExplorerStates((previousStates) => ({
          ...previousStates,
          [windowId]: createDefaultDesktopExplorerState(),
        }));
        void loadDirectory("");
      } else if (isTextEditorApp) {
        setDesktopEditorStates((previousStates) => ({
          ...previousStates,
          [windowId]: createDefaultDesktopEditorWindowState(),
        }));
      } else if (appKind === "terminal-workspace") {
        setDesktopTerminalStates((previousStates) => ({
          ...previousStates,
          [windowId]:
            options?.initialTerminalState ??
            createDefaultDesktopTerminalWindowState(),
        }));
      }

      setDesktopWindows((previousWindows) => [
        ...previousWindows,
        {
          id: windowId,
          app_kind: appKind,
          title: isFileExplorerApp
            ? existingWindowCount > 0
              ? `File Explorer ${existingWindowCount + 1}`
              : "File Explorer"
            : isSettingsApp
              ? "Desktop Settings"
              : isTextEditorApp
                ? existingWindowCount > 0
                  ? `Text Editor ${existingWindowCount + 1}`
                  : "Text Editor"
                : existingWindowCount > 0
                  ? `Terminal ${existingWindowCount + 1}`
                  : "Terminal",
          x: isFileExplorerApp
            ? 42 + existingOffset
            : isSettingsApp
              ? Math.max(72, Math.round((workspaceBounds.width - width) / 2))
              : isTextEditorApp
                ? Math.max(52, Math.round((workspaceBounds.width - width) / 2))
                : Math.max(56, Math.round((workspaceBounds.width - width) / 2)),
          y: isFileExplorerApp
            ? 42 + existingOffset
            : isSettingsApp
              ? 72
              : isTextEditorApp
                ? 48
                : 54,
          width,
          height,
          z_index: highestPreviewZIndexRef.current,
          snapped_zone: null,
          is_maximized: false,
          is_minimized: false,
          restore_bounds: null,
        },
      ]);
      return windowId;
    },
    [
      desktopWindows,
      focusDesktopWindow,
      loadDirectory,
      workspaceBounds.height,
      workspaceBounds.width,
    ]
  );

  const openPreview = useCallback(
    (
      entry: NeuralLabsFileEntry,
      options?: { syncLegacySelection?: boolean }
    ) => {
      if (isTextEditorEntry(entry)) {
        if (options?.syncLegacySelection !== false) {
          setSelectedPath(entry.path);
          setCurrentPath(getParentPath(entry.path));
        }
        openTextFileInEditor(entry);
        return;
      }

      const previewKind = getPreviewKind(entry);
      if (!previewKind) {
        return;
      }

      if (options?.syncLegacySelection !== false) {
        setSelectedPath(entry.path);
        setCurrentPath(getParentPath(entry.path));
      }
      const existingWindow = previewWindows.find(
        (windowState) => windowState.path === entry.path
      );
      if (existingWindow) {
        focusPreviewWindow(existingWindow.id);
        return;
      }

      highestPreviewZIndexRef.current += 1;
      const width =
        workspaceBounds.width > 0
          ? Math.min(720, Math.max(420, workspaceBounds.width * 0.66))
          : 720;
      const height =
        workspaceBounds.height > 0
          ? Math.min(540, Math.max(320, workspaceBounds.height * 0.66))
          : 480;
      const offset = previewWindows.length * 28;

      setPreviewWindows((previousWindows) => [
        ...previousWindows,
        {
          id: createLocalId(),
          path: entry.path,
          name: entry.name,
          mime_type: entry.mime_type,
          preview_kind: previewKind,
          x: 24 + offset,
          y: 24 + offset,
          width,
          height,
          z_index: highestPreviewZIndexRef.current,
          snapped_zone: null,
          is_maximized: false,
          is_minimized: false,
          restore_bounds: null,
        },
      ]);
    },
    [
      focusPreviewWindow,
      openTextFileInEditor,
      previewWindows,
      workspaceBounds.height,
      workspaceBounds.width,
    ]
  );

  const createFolderAtPath = useCallback(
    async (parentPath: string) => {
      const folderNameInput = window.prompt("New folder name");
      if (folderNameInput === null) {
        return null;
      }
      const folderName = folderNameInput.trim();
      if (!folderName) {
        toast.error("Folder name cannot be empty");
        return null;
      }

      const requestCreateDirectory = async (
        targetParentPath: string
      ): Promise<{ response: Response; message: string | null }> => {
        const response = await fetch(
          `${NEURAL_LABS_API_PREFIX}/files/directory`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              parent_path: targetParentPath,
              name: folderName,
            }),
          }
        );

        if (response.ok) {
          return { response, message: null };
        }

        return {
          response,
          message: await getFetchErrorMessage(response),
        };
      };

      let resolvedParentPath = parentPath;
      let createResult = await requestCreateDirectory(resolvedParentPath);

      if (
        !createResult.response.ok &&
        resolvedParentPath &&
        (createResult.response.status === 404 ||
          (createResult.message ?? "")
            .toLowerCase()
            .includes("parent directory not found"))
      ) {
        resolvedParentPath = "";
        createResult = await requestCreateDirectory(resolvedParentPath);
      }

      if (!createResult.response.ok) {
        toast.error(createResult.message ?? "Unable to create folder");
        return null;
      }

      let createdPath: string | null = null;
      try {
        const payload = (await createResult.response.json()) as {
          path?: string;
        };
        if (typeof payload.path === "string") {
          createdPath = payload.path;
        }
      } catch {
        // Ignore response parse failures for non-critical UI state updates.
      }

      await refreshDirectoryPaths([resolvedParentPath]);
      return createdPath;
    },
    [refreshDirectoryPaths]
  );

  const createFolder = useCallback(async () => {
    const resolveParentPath = (): string => {
      if (!currentPath) {
        return "";
      }

      if (treeEntries[currentPath]) {
        return currentPath;
      }

      for (const entries of Object.values(treeEntries)) {
        const match = entries.find((entry) => entry.path === currentPath);
        if (!match) {
          continue;
        }
        return match.is_directory ? match.path : getParentPath(match.path);
      }

      return "";
    };

    const createdPath = await createFolderAtPath(resolveParentPath());
    if (createdPath) {
      setSelectedPath(createdPath);
      setCurrentPath(getParentPath(createdPath));
    }
  }, [createFolderAtPath, currentPath, treeEntries]);

  const renameEntryAtPath = useCallback(
    async (entry: NeuralLabsFileEntry) => {
      const newName = window.prompt("Rename to:", entry.name);
      if (!newName || newName === entry.name) {
        return null;
      }

      const response = await fetch(`${NEURAL_LABS_API_PREFIX}/files/rename`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: entry.path, new_name: newName }),
      });

      if (!response.ok) {
        toast.error(await getFetchErrorMessage(response));
        return null;
      }

      const payload = (await response.json()) as { path?: string };
      const renamedPath =
        typeof payload.path === "string" ? payload.path : entry.path;
      setDesktopEditorStates((previousStates) => {
        let didChange = false;
        const nextStates = Object.fromEntries(
          Object.entries(previousStates).map(([windowId, state]) => {
            const nextTabs = state.tabs.map((tab) => {
              if (!tab.path) {
                return tab;
              }

              const nextPath = replacePathPrefix(
                tab.path,
                entry.path,
                renamedPath
              );
              if (nextPath === tab.path) {
                return tab;
              }

              didChange = true;
              return {
                ...tab,
                path: nextPath,
                name: nextPath.split("/").pop() ?? nextPath,
              };
            });
            return [windowId, { ...state, tabs: nextTabs }];
          })
        );

        return didChange ? nextStates : previousStates;
      });
      await refreshDirectoryPaths([
        getParentPath(entry.path),
        getParentPath(renamedPath),
      ]);
      return renamedPath;
    },
    [refreshDirectoryPaths]
  );

  const renamePath = useCallback(
    async (entry: NeuralLabsFileEntry) => {
      const renamedPath = await renameEntryAtPath(entry);
      if (renamedPath) {
        setSelectedPath(renamedPath);
        setCurrentPath(getParentPath(renamedPath));
      }
    },
    [renameEntryAtPath]
  );

  const deleteEntryAtPath = useCallback(
    async (entry: NeuralLabsFileEntry) => {
      const confirmed = window.confirm(
        `Delete ${entry.is_directory ? "folder" : "file"} "${entry.name}"?`
      );
      if (!confirmed) {
        return false;
      }

      const response = await fetch(
        `${NEURAL_LABS_API_PREFIX}/files?path=${encodeURIComponent(
          entry.path
        )}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        toast.error(await getFetchErrorMessage(response));
        return false;
      }

      setPreviewWindows((previousWindows) =>
        previousWindows.filter(
          (windowState) =>
            windowState.path !== entry.path &&
            !windowState.path.startsWith(`${entry.path}/`)
        )
      );
      setDesktopEditorStates((previousStates) => {
        let didChange = false;
        const nextStates = Object.fromEntries(
          Object.entries(previousStates).map(([windowId, state]) => {
            const remainingTabs = state.tabs.filter((tab) => {
              if (!tab.path) {
                return true;
              }

              const shouldRemove =
                tab.path === entry.path ||
                tab.path.startsWith(`${entry.path}/`);
              if (shouldRemove) {
                didChange = true;
              }
              return !shouldRemove;
            });

            if (remainingTabs.length === 0) {
              const scratchTab = createScratchEditorTab();
              return [
                windowId,
                {
                  ...state,
                  tabs: [scratchTab],
                  active_tab_id: scratchTab.tab_id,
                },
              ];
            }

            const activeTabExists = remainingTabs.some(
              (tab) => tab.tab_id === state.active_tab_id
            );
            return [
              windowId,
              {
                ...state,
                tabs: remainingTabs,
                active_tab_id: activeTabExists
                  ? state.active_tab_id
                  : remainingTabs[0]!.tab_id,
              },
            ];
          })
        );

        return didChange ? nextStates : previousStates;
      });
      await refreshDirectoryPaths([getParentPath(entry.path)]);
      return true;
    },
    [refreshDirectoryPaths]
  );

  const deletePath = useCallback(
    async (entry: NeuralLabsFileEntry) => {
      const didDelete = await deleteEntryAtPath(entry);
      if (!didDelete) {
        return;
      }

      setSelectedPath((previousPath) =>
        previousPath === entry.path ? null : previousPath
      );
      setCurrentPath((previousPath) =>
        previousPath === entry.path ? getParentPath(entry.path) : previousPath
      );
    },
    [deleteEntryAtPath]
  );

  const triggerUpload = useCallback(() => {
    fileUploadInputRef.current?.click();
  }, []);

  const uploadFilesToPath = useCallback(
    async (files: File[], destinationPath: string) => {
      if (files.length === 0) {
        return;
      }

      const failedUploads: string[] = [];
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("path", destinationPath);

        const response = await fetch(`${NEURAL_LABS_API_PREFIX}/files/upload`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          failedUploads.push(file.name);
        }
      }

      if (failedUploads.length > 0) {
        const failedList = failedUploads.slice(0, 3).join(", ");
        const overflow =
          failedUploads.length > 3
            ? ` and ${failedUploads.length - 3} more`
            : "";
        toast.error(`Failed to upload: ${failedList}${overflow}`);
      } else if (files.length > 1) {
        toast.success(`Uploaded ${files.length} files`);
      } else {
        toast.success(`Uploaded ${files[0]!.name}`);
      }

      if (destinationPath) {
        setExpandedPaths((previousPaths) =>
          previousPaths.includes(destinationPath)
            ? previousPaths
            : [...previousPaths, destinationPath]
        );
      }

      await refreshDirectoryPaths([destinationPath]);
    },
    [refreshDirectoryPaths]
  );

  const uploadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? Array.from(event.target.files) : [];
      event.target.value = "";
      await uploadFilesToPath(files, currentPath);
    },
    [currentPath, uploadFilesToPath]
  );

  const uploadCustomBackground = useCallback(
    async (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast.error("Choose an image file for the desktop background");
        return;
      }

      setIsUploadingCustomBackground(true);

      try {
        const uploadFileName = getCustomDesktopBackgroundFilename(file);
        const uploadTargetPath = `${CUSTOM_DESKTOP_BACKGROUND_DIRECTORY}/${uploadFileName}`;
        const formData = new FormData();
        formData.append(
          "file",
          new File([file], uploadFileName, { type: file.type || undefined })
        );
        formData.append("path", CUSTOM_DESKTOP_BACKGROUND_DIRECTORY);

        const response = await fetch(`${NEURAL_LABS_API_PREFIX}/files/upload`, {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          throw new Error(await getFetchErrorMessage(response));
        }

        const payload = (await response.json()) as { path?: string };
        const nextPath =
          typeof payload.path === "string" && payload.path
            ? payload.path
            : uploadTargetPath;

        setDesktopCustomBackgroundPath(nextPath);
        setDesktopBackgroundId(
          createCustomDesktopBackgroundSelection(nextPath)
        );
        setExpandedPaths((previousPaths) =>
          previousPaths.includes(CUSTOM_DESKTOP_BACKGROUND_DIRECTORY)
            ? previousPaths
            : [...previousPaths, CUSTOM_DESKTOP_BACKGROUND_DIRECTORY]
        );
        await refreshDirectoryPaths([CUSTOM_DESKTOP_BACKGROUND_DIRECTORY], {
          silent: true,
        });
        toast.success(`Uploaded ${file.name}`);
      } catch (error) {
        const message =
          error instanceof Error && error.message
            ? error.message
            : "Unable to upload custom background";
        toast.error(message);
      } finally {
        setIsUploadingCustomBackground(false);
      }
    },
    [refreshDirectoryPaths]
  );

  const selectCustomBackground = useCallback(() => {
    if (!desktopCustomBackgroundPath) {
      toast.error("Upload a custom background first");
      return;
    }

    setDesktopBackgroundId(
      createCustomDesktopBackgroundSelection(desktopCustomBackgroundPath)
    );
  }, [desktopCustomBackgroundPath]);

  const deleteCustomBackground = useCallback(async () => {
    if (!desktopCustomBackgroundPath) {
      return;
    }

    const confirmed = window.confirm(
      'Delete the uploaded desktop background "custom-background"?'
    );
    if (!confirmed) {
      return;
    }

    setIsDeletingCustomBackground(true);

    try {
      const response = await fetch(
        `${NEURAL_LABS_API_PREFIX}/files?path=${encodeURIComponent(
          desktopCustomBackgroundPath
        )}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        throw new Error(await getFetchErrorMessage(response));
      }

      setDesktopCustomBackgroundPath(null);
      if (desktopBackgroundId.startsWith(CUSTOM_DESKTOP_BACKGROUND_PREFIX)) {
        setDesktopBackgroundId("sunset-grid");
      }
      await refreshDirectoryPaths([CUSTOM_DESKTOP_BACKGROUND_DIRECTORY], {
        silent: true,
      });
      toast.success("Deleted uploaded background");
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unable to delete custom background";
      toast.error(message);
    } finally {
      setIsDeletingCustomBackground(false);
    }
  }, [desktopBackgroundId, desktopCustomBackgroundPath, refreshDirectoryPaths]);

  const downloadFile = useCallback((entry: NeuralLabsFileEntry) => {
    triggerBrowserDownload(entry.path, entry.name);
  }, []);

  const copyPath = useCallback(async (entry: NeuralLabsFileEntry) => {
    const shellPath = entry.path ? `~/${entry.path}` : "~";
    try {
      await navigator.clipboard.writeText(shellPath);
      toast.success(`Copied path: ${shellPath}`);
    } catch {
      toast.error("Unable to copy path");
    }
  }, []);

  const moveEntryToPath = useCallback(
    async (entry: NeuralLabsFileEntry, destinationPath: string) => {
      if (getParentPath(entry.path) === destinationPath) {
        return entry.path;
      }

      const response = await fetch(`${NEURAL_LABS_API_PREFIX}/files/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: entry.path,
          destination_parent_path: destinationPath,
        }),
      });

      if (!response.ok) {
        toast.error(await getFetchErrorMessage(response));
        return null;
      }

      const payload = (await response.json()) as { path?: string };
      const movedPath = typeof payload.path === "string" ? payload.path : null;
      if (movedPath) {
        setDesktopEditorStates((previousStates) => {
          let didChange = false;
          const nextStates = Object.fromEntries(
            Object.entries(previousStates).map(([windowId, state]) => {
              const nextTabs = state.tabs.map((tab) => {
                if (!tab.path) {
                  return tab;
                }

                const nextPath = replacePathPrefix(
                  tab.path,
                  entry.path,
                  movedPath
                );
                if (nextPath === tab.path) {
                  return tab;
                }

                didChange = true;
                return {
                  ...tab,
                  path: nextPath,
                  name: nextPath.split("/").pop() ?? nextPath,
                };
              });

              return [windowId, { ...state, tabs: nextTabs }];
            })
          );

          return didChange ? nextStates : previousStates;
        });
      }
      await refreshDirectoryPaths(
        [getParentPath(entry.path), destinationPath],
        {
          silent: true,
        }
      );
      return movedPath;
    },
    [refreshDirectoryPaths]
  );

  const moveEntry = useCallback(
    async (entry: NeuralLabsFileEntry, destinationPath: string) => {
      const movedPath = await moveEntryToPath(entry, destinationPath);
      if (movedPath === null) {
        return;
      }
      setSelectedPath(movedPath || null);
      setCurrentPath(destinationPath);
      if (destinationPath) {
        setExpandedPaths((previousPaths) =>
          previousPaths.includes(destinationPath)
            ? previousPaths
            : [...previousPaths, destinationPath]
        );
      }
    },
    [moveEntryToPath]
  );

  const moveEntries = useCallback(
    async (entriesToMove: NeuralLabsFileEntry[], destinationPath: string) => {
      const uniqueEntries = entriesToMove.filter(
        (entry, index, allEntries) =>
          allEntries.findIndex((candidate) => candidate.path === entry.path) ===
          index
      );
      if (uniqueEntries.length === 0) {
        return [];
      }

      const movedPaths: string[] = [];
      for (const entry of uniqueEntries) {
        const movedPath = await moveEntryToPath(entry, destinationPath);
        if (movedPath) {
          movedPaths.push(movedPath);
        }
      }

      return movedPaths;
    },
    [moveEntryToPath]
  );

  const activateTreeEntry = useCallback(
    (entry: NeuralLabsFileEntry) => {
      if (entry.is_directory) {
        toggleDirectory(entry);
        return;
      }

      if (isPreviewable(entry)) {
        openPreview(entry);
      }
    },
    [openPreview, toggleDirectory]
  );

  useEffect(() => {
    const persistedTreeState = loadPersistedTreeState();
    const persistedPreviewWindows = loadPersistedPreviewWindows();

    if (persistedTreeState) {
      setCurrentPath(persistedTreeState.current_path);
      setExpandedPaths(persistedTreeState.expanded_paths);
      setSelectedPath(persistedTreeState.selected_path);
    }

    if (persistedPreviewWindows.length > 0) {
      highestPreviewZIndexRef.current = Math.max(
        ...persistedPreviewWindows.map((windowState) => windowState.z_index),
        1
      );
      setPreviewWindows(persistedPreviewWindows);
    }

    const pathsToLoad = new Set<string>([""]);
    persistedTreeState?.expanded_paths.forEach((path) => pathsToLoad.add(path));
    void Promise.all(
      Array.from(pathsToLoad).map((path) => loadDirectory(path))
    );
  }, [loadDirectory]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (document.hidden || treeSyncInFlightRef.current) {
        return;
      }
      treeSyncInFlightRef.current = true;
      void refreshDirectory({ silent: true }).finally(() => {
        treeSyncInFlightRef.current = false;
      });
    }, TREE_AUTO_SYNC_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshDirectory]);

  useEffect(() => {
    const workspaceNode = previewWorkspaceRef.current;
    if (!workspaceNode) {
      return;
    }

    const syncBounds = () => {
      setWorkspaceBounds({
        width: workspaceNode.clientWidth,
        height: workspaceNode.clientHeight,
      });
    };

    syncBounds();
    const resizeObserver = new ResizeObserver(syncBounds);
    resizeObserver.observe(workspaceNode);

    return () => {
      resizeObserver.disconnect();
    };
  }, [isDesktopModeActive]);

  useEffect(() => {
    persistTreeState({
      current_path: currentPath,
      expanded_paths: expandedPaths,
      selected_path: selectedPath,
    });
  }, [currentPath, expandedPaths, selectedPath]);

  useEffect(() => {
    persistPreviewWindows(previewWindows);
  }, [previewWindows]);

  const listTerminals = useCallback(async (): Promise<string[]> => {
    const response = await fetch(`${NEURAL_LABS_API_PREFIX}/terminals`);
    if (!response.ok) {
      throw new Error(await getFetchErrorMessage(response));
    }
    const payload = (await response.json()) as TerminalListResponse;
    return payload.terminals.map((terminal) => terminal.terminal_id);
  }, []);

  const createTerminal = useCallback(async (): Promise<string> => {
    const response = await fetch(`${NEURAL_LABS_API_PREFIX}/terminals`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(await getFetchErrorMessage(response));
    }
    const payload = (await response.json()) as TerminalDescriptor;
    return payload.terminal_id;
  }, []);

  const initializeDesktopTerminalWindow = useCallback(
    async (windowId: string) => {
      if (desktopTerminalInitInFlightRef.current.has(windowId)) {
        return;
      }

      desktopTerminalInitInFlightRef.current.add(windowId);

      try {
        const warmupResponse = await fetch(`${NEURAL_LABS_API_PREFIX}/warmup`, {
          method: "POST",
        });
        if (!warmupResponse.ok) {
          throw new Error(await getFetchErrorMessage(warmupResponse));
        }

        const warmupPayload = (await warmupResponse.json()) as WarmupResponse;
        const terminalId =
          warmupPayload.terminal_id ?? (await createTerminal());

        if (!desktopTerminalStatesRef.current[windowId]) {
          await deleteTerminalById(terminalId);
          return;
        }

        const tab = createTabFromTerminal(terminalId, []);
        updateDesktopTerminalState(windowId, {
          layout: {
            tabs: [tab],
            active_tab_id: tab.tab_id,
          },
          is_initializing: false,
        });
      } catch (error) {
        toast.error(
          `Unable to initialize terminal window: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
        updateDesktopTerminalState(windowId, {
          layout: { tabs: [], active_tab_id: "" },
          is_initializing: false,
        });
      } finally {
        desktopTerminalInitInFlightRef.current.delete(windowId);
      }
    },
    [createTerminal, updateDesktopTerminalState]
  );

  const setActiveDesktopTerminalTab = useCallback(
    (windowId: string, tabId: string) => {
      updateDesktopTerminalState(windowId, (currentState) => {
        if (!currentState.layout) {
          return currentState;
        }

        return {
          ...currentState,
          layout: {
            ...currentState.layout,
            active_tab_id: tabId,
          },
        };
      });
    },
    [updateDesktopTerminalState]
  );

  const setActiveDesktopTerminalPane = useCallback(
    (windowId: string, tabId: string, paneId: string) => {
      updateDesktopTerminalState(windowId, (currentState) => {
        if (!currentState.layout) {
          return currentState;
        }

        return {
          ...currentState,
          layout: {
            ...currentState.layout,
            active_tab_id: tabId,
            tabs: currentState.layout.tabs.map((tab) =>
              tab.tab_id === tabId ? { ...tab, active_pane_id: paneId } : tab
            ),
          },
        };
      });
    },
    [updateDesktopTerminalState]
  );

  const reorderDesktopTerminalTabs = useCallback(
    (windowId: string, sourceTabId: string, targetTabId: string) => {
      updateDesktopTerminalState(windowId, (currentState) => {
        if (!currentState.layout || sourceTabId === targetTabId) {
          return currentState;
        }

        const sourceIndex = currentState.layout.tabs.findIndex(
          (tab) => tab.tab_id === sourceTabId
        );
        const targetIndex = currentState.layout.tabs.findIndex(
          (tab) => tab.tab_id === targetTabId
        );
        if (sourceIndex === -1 || targetIndex === -1) {
          return currentState;
        }

        const nextTabs = [...currentState.layout.tabs];
        const [movedTab] = nextTabs.splice(sourceIndex, 1);
        if (!movedTab) {
          return currentState;
        }
        nextTabs.splice(targetIndex, 0, movedTab);

        return {
          ...currentState,
          layout: {
            ...currentState.layout,
            tabs: nextTabs,
          },
        };
      });
    },
    [updateDesktopTerminalState]
  );

  const renameDesktopTerminalTab = useCallback(
    (windowId: string, tabId: string) => {
      const currentState = desktopTerminalStatesRef.current[windowId];
      const tab = currentState?.layout?.tabs.find(
        (candidate) => candidate.tab_id === tabId
      );
      if (!tab) {
        return;
      }

      const nextTitle = window.prompt("Rename tab:", tab.title)?.trim();
      if (!nextTitle || nextTitle === tab.title) {
        return;
      }

      updateDesktopTerminalState(windowId, (existingState) => {
        if (!existingState.layout) {
          return existingState;
        }

        return {
          ...existingState,
          layout: {
            ...existingState.layout,
            tabs: existingState.layout.tabs.map((candidate) =>
              candidate.tab_id === tabId
                ? { ...candidate, title: nextTitle }
                : candidate
            ),
          },
        };
      });
    },
    [updateDesktopTerminalState]
  );

  const addDesktopTerminalTab = useCallback(
    async (windowId: string) => {
      try {
        const terminalId = await createTerminal();
        if (!desktopTerminalStatesRef.current[windowId]) {
          await deleteTerminalById(terminalId);
          return;
        }

        updateDesktopTerminalState(windowId, (currentState) => {
          const layout = currentState.layout ?? { tabs: [], active_tab_id: "" };
          const tab = createTabFromTerminal(terminalId, layout.tabs);
          return {
            ...currentState,
            is_initializing: false,
            layout: {
              tabs: [...layout.tabs, tab],
              active_tab_id: tab.tab_id,
            },
          };
        });
      } catch (error) {
        toast.error(
          `Unable to create terminal tab: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    },
    [createTerminal, updateDesktopTerminalState]
  );

  const splitDesktopTerminalTab = useCallback(
    async (
      windowId: string,
      tabId: string,
      direction: "horizontal" | "vertical"
    ) => {
      const currentState = desktopTerminalStatesRef.current[windowId];
      const tab = currentState?.layout?.tabs.find(
        (candidate) => candidate.tab_id === tabId
      );
      if (!tab || tab.panes.length !== 1) {
        return;
      }

      try {
        const terminalId = await createTerminal();
        if (!desktopTerminalStatesRef.current[windowId]) {
          await deleteTerminalById(terminalId);
          return;
        }

        const newPane: TerminalPaneState = {
          pane_id: createLocalId(),
          terminal_id: terminalId,
        };

        updateDesktopTerminalState(windowId, (existingState) => {
          if (!existingState.layout) {
            return existingState;
          }

          return {
            ...existingState,
            layout: {
              ...existingState.layout,
              active_tab_id: tabId,
              tabs: existingState.layout.tabs.map((candidate) =>
                candidate.tab_id === tabId
                  ? {
                      ...candidate,
                      split_mode: direction,
                      panes: [...candidate.panes, newPane],
                      active_pane_id: newPane.pane_id,
                    }
                  : candidate
              ),
            },
          };
        });
      } catch (error) {
        toast.error(
          `Unable to split terminal: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    },
    [createTerminal, updateDesktopTerminalState]
  );

  const duplicateDesktopTerminalTab = useCallback(
    async (windowId: string, tabId: string) => {
      const currentState = desktopTerminalStatesRef.current[windowId];
      const sourceTab = currentState?.layout?.tabs.find(
        (candidate) => candidate.tab_id === tabId
      );
      if (!sourceTab) {
        return;
      }

      try {
        const terminalId = await createTerminal();
        if (!desktopTerminalStatesRef.current[windowId]) {
          await deleteTerminalById(terminalId);
          return;
        }

        updateDesktopTerminalState(windowId, (existingState) => {
          const layout = existingState.layout ?? {
            tabs: [],
            active_tab_id: "",
          };
          const duplicateTitle = `${sourceTab.title} Copy`;
          const tab = createTabFromTerminal(
            terminalId,
            layout.tabs,
            duplicateTitle
          );

          return {
            ...existingState,
            layout: {
              tabs: [...layout.tabs, tab],
              active_tab_id: tab.tab_id,
            },
          };
        });
      } catch (error) {
        toast.error(
          `Unable to duplicate terminal tab: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    },
    [createTerminal, updateDesktopTerminalState]
  );

  const closeDesktopTerminalTab = useCallback(
    async (windowId: string, tabId: string) => {
      const currentState = desktopTerminalStatesRef.current[windowId];
      const tab = currentState?.layout?.tabs.find(
        (candidate) => candidate.tab_id === tabId
      );
      if (!tab) {
        return;
      }

      for (const terminalId of tab.panes.map((pane) => pane.terminal_id)) {
        try {
          await deleteTerminalById(terminalId);
        } catch (error) {
          toast.error(
            `Failed closing terminal: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }

      const latestState = desktopTerminalStatesRef.current[windowId];
      const latestLayout = latestState?.layout;
      if (!latestLayout) {
        return;
      }

      const remainingTabs = latestLayout.tabs.filter(
        (candidate) => candidate.tab_id !== tabId
      );
      if (remainingTabs.length === 0) {
        removeDesktopWindowRecord(windowId);
        return;
      }

      const closedIndex = latestLayout.tabs.findIndex(
        (candidate) => candidate.tab_id === tabId
      );
      const fallbackTab =
        remainingTabs[Math.max(0, closedIndex - 1)] ?? remainingTabs[0] ?? null;

      updateDesktopTerminalState(windowId, {
        layout: {
          tabs: remainingTabs,
          active_tab_id:
            latestLayout.active_tab_id === tabId
              ? fallbackTab?.tab_id ?? ""
              : latestLayout.active_tab_id,
        },
      });
    },
    [removeDesktopWindowRecord, updateDesktopTerminalState]
  );

  const closeDesktopTerminalPane = useCallback(
    async (windowId: string, tabId: string, paneId: string) => {
      const currentState = desktopTerminalStatesRef.current[windowId];
      const tab = currentState?.layout?.tabs.find(
        (candidate) => candidate.tab_id === tabId
      );
      const pane = tab?.panes.find((candidate) => candidate.pane_id === paneId);
      if (!tab || !pane) {
        return;
      }

      if (tab.panes.length === 1) {
        await closeDesktopTerminalTab(windowId, tabId);
        return;
      }

      try {
        await deleteTerminalById(pane.terminal_id);
      } catch (error) {
        toast.error(
          `Failed closing terminal pane: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
        return;
      }

      updateDesktopTerminalState(windowId, (existingState) => {
        if (!existingState.layout) {
          return existingState;
        }

        return {
          ...existingState,
          layout: {
            ...existingState.layout,
            active_tab_id: tabId,
            tabs: existingState.layout.tabs.map((candidate) => {
              if (candidate.tab_id !== tabId) {
                return candidate;
              }

              const remainingPanes = candidate.panes.filter(
                (paneCandidate) => paneCandidate.pane_id !== paneId
              );
              const fallbackPane =
                remainingPanes.find(
                  (paneCandidate) =>
                    paneCandidate.pane_id === candidate.active_pane_id
                ) ??
                remainingPanes[0] ??
                null;

              return {
                ...candidate,
                split_mode:
                  remainingPanes.length === 1 ? "none" : candidate.split_mode,
                panes: remainingPanes,
                active_pane_id: fallbackPane?.pane_id ?? "",
              };
            }),
          },
        };
      });
    },
    [closeDesktopTerminalTab, updateDesktopTerminalState]
  );

  const moveDesktopTerminalTabToNewWindow = useCallback(
    (windowId: string, tabId: string) => {
      const currentState = desktopTerminalStatesRef.current[windowId];
      const layout = currentState?.layout;
      const tab = layout?.tabs.find((candidate) => candidate.tab_id === tabId);
      if (!layout || !tab) {
        return;
      }

      openDesktopApp("terminal-workspace", {
        forceNew: true,
        initialTerminalState: {
          layout: {
            tabs: [tab],
            active_tab_id: tab.tab_id,
          },
          is_initializing: false,
        },
      });

      const remainingTabs = layout.tabs.filter(
        (candidate) => candidate.tab_id !== tabId
      );
      if (remainingTabs.length === 0) {
        removeDesktopWindowRecord(windowId);
        return;
      }

      const closedIndex = layout.tabs.findIndex(
        (candidate) => candidate.tab_id === tabId
      );
      const fallbackTab =
        remainingTabs[Math.max(0, closedIndex - 1)] ?? remainingTabs[0] ?? null;

      updateDesktopTerminalState(windowId, {
        layout: {
          tabs: remainingTabs,
          active_tab_id:
            layout.active_tab_id === tabId
              ? fallbackTab?.tab_id ?? ""
              : layout.active_tab_id,
        },
      });
    },
    [openDesktopApp, removeDesktopWindowRecord, updateDesktopTerminalState]
  );

  useEffect(() => {
    const pendingWindowIds = desktopWindows
      .filter((windowState) => windowState.app_kind === "terminal-workspace")
      .map((windowState) => windowState.id)
      .filter((windowId) => {
        const terminalState = desktopTerminalStates[windowId];
        if (!terminalState) {
          return false;
        }

        return (
          terminalState.is_initializing &&
          terminalState.layout === null &&
          !desktopTerminalInitInFlightRef.current.has(windowId)
        );
      });

    pendingWindowIds.forEach((windowId) => {
      void initializeDesktopTerminalWindow(windowId);
    });
  }, [desktopTerminalStates, desktopWindows, initializeDesktopTerminalWindow]);

  const reconcileLiveTerminals = useCallback(
    async (preferredActiveTerminalId?: string | null) => {
      const desktopTerminalIds = new Set(
        Object.values(desktopTerminalStatesRef.current).flatMap((state) =>
          getTerminalIdsFromLayout(state.layout)
        )
      );
      let terminalIds = (await listTerminals()).filter(
        (terminalId) => !desktopTerminalIds.has(terminalId)
      );
      if (terminalIds.length === 0) {
        const terminalId = await createTerminal();
        terminalIds = [terminalId];
      }

      setLayout((prev) => {
        const baselineLayout = prev ?? loadPersistedLayout();
        const nextLayout = reconcileLayout(baselineLayout, terminalIds);
        const preferredTabId = findTabIdForTerminal(
          nextLayout,
          preferredActiveTerminalId
        );

        if (preferredTabId) {
          return {
            ...nextLayout,
            active_tab_id: preferredTabId,
          };
        }

        return nextLayout;
      });
    },
    [createTerminal, listTerminals]
  );

  const setActiveTab = useCallback((tabId: string) => {
    setLayout((prev) => {
      if (!prev) {
        return prev;
      }
      return { ...prev, active_tab_id: tabId };
    });
  }, []);

  const setActivePane = useCallback((tabId: string, paneId: string) => {
    setLayout((prev) => {
      if (!prev) {
        return prev;
      }
      return {
        ...prev,
        active_tab_id: tabId,
        tabs: prev.tabs.map((tab) =>
          tab.tab_id === tabId ? { ...tab, active_pane_id: paneId } : tab
        ),
      };
    });
  }, []);

  const addTab = useCallback(async () => {
    try {
      const terminalId = await createTerminal();
      setLayout((prev) => {
        if (!prev) {
          const tab = createTabFromTerminal(terminalId, []);
          return { tabs: [tab], active_tab_id: tab.tab_id };
        }

        const tab = createTabFromTerminal(terminalId, prev.tabs);
        return {
          ...prev,
          tabs: [...prev.tabs, tab],
          active_tab_id: tab.tab_id,
        };
      });
    } catch (error) {
      toast.error(
        `Unable to create terminal tab: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }, [createTerminal]);

  const splitActiveTab = useCallback(
    async (direction: "horizontal" | "vertical") => {
      const current = layoutRef.current;
      if (!current) {
        return;
      }

      const tab = current.tabs.find(
        (candidate) => candidate.tab_id === current.active_tab_id
      );
      if (!tab || tab.panes.length !== 1) {
        return;
      }

      try {
        const terminalId = await createTerminal();
        const newPane: TerminalPaneState = {
          pane_id: createLocalId(),
          terminal_id: terminalId,
        };

        setLayout((prev) => {
          if (!prev) {
            return prev;
          }

          return {
            ...prev,
            tabs: prev.tabs.map((candidateTab) => {
              if (candidateTab.tab_id !== tab.tab_id) {
                return candidateTab;
              }
              return {
                ...candidateTab,
                split_mode: direction,
                panes: [...candidateTab.panes, newPane],
                active_pane_id: newPane.pane_id,
              };
            }),
          };
        });
      } catch (error) {
        toast.error(
          `Unable to split terminal: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    },
    [createTerminal]
  );

  const closeTabById = useCallback(
    async (tabId: string) => {
      const current = layoutRef.current;
      if (!current) {
        return;
      }

      const tab = current.tabs.find((candidate) => candidate.tab_id === tabId);
      if (!tab) {
        return;
      }

      for (const pane of tab.panes) {
        try {
          await deleteTerminalById(pane.terminal_id);
        } catch (error) {
          toast.error(
            `Failed closing terminal: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }

      let nextLayout = layoutRef.current;
      if (!nextLayout) {
        return;
      }

      const remainingTabs = nextLayout.tabs.filter(
        (candidate) => candidate.tab_id !== tabId
      );
      if (remainingTabs.length === 0) {
        try {
          const replacementTerminalId = await createTerminal();
          const replacementTab = createTabFromTerminal(
            replacementTerminalId,
            []
          );
          setLayout({
            tabs: [replacementTab],
            active_tab_id: replacementTab.tab_id,
          });
        } catch (error) {
          toast.error(
            `Unable to open replacement terminal: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
          setLayout({ tabs: [], active_tab_id: "" });
        }
        return;
      }

      const nextActiveId =
        nextLayout.active_tab_id === tabId
          ? remainingTabs[
              Math.max(
                0,
                nextLayout.tabs.findIndex((t) => t.tab_id === tabId) - 1
              )
            ]?.tab_id ?? remainingTabs[0]!.tab_id
          : nextLayout.active_tab_id;

      setLayout({ tabs: remainingTabs, active_tab_id: nextActiveId });
    },
    [createTerminal]
  );

  const closePaneById = useCallback(
    async (tabId: string, paneId: string) => {
      const current = layoutRef.current;
      if (!current) {
        return;
      }

      const tab = current.tabs.find((candidate) => candidate.tab_id === tabId);
      if (!tab) {
        return;
      }

      const pane = tab.panes.find((candidate) => candidate.pane_id === paneId);
      if (!pane) {
        return;
      }

      try {
        await deleteTerminalById(pane.terminal_id);
      } catch (error) {
        toast.error(
          `Failed closing terminal pane: ${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
        return;
      }

      if (tab.panes.length === 1) {
        await closeTabById(tab.tab_id);
        return;
      }

      const remainingPanes = tab.panes.filter(
        (candidate) => candidate.pane_id !== pane.pane_id
      );
      const activePaneId =
        tab.active_pane_id === pane.pane_id
          ? remainingPanes[0]!.pane_id
          : tab.active_pane_id;

      setLayout((prev) => {
        if (!prev) {
          return prev;
        }

        return {
          ...prev,
          tabs: prev.tabs.map((candidate) => {
            if (candidate.tab_id !== tab.tab_id) {
              return candidate;
            }
            return {
              ...candidate,
              split_mode:
                remainingPanes.length === 1 ? "none" : candidate.split_mode,
              panes: remainingPanes,
              active_pane_id: activePaneId,
            };
          }),
        };
      });
    },
    [closeTabById]
  );

  useEffect(() => {
    if (!hasLoadedUiMode || isDesktopModeActive) {
      return;
    }

    let isCancelled = false;

    const initialize = async () => {
      setIsInitializingTerminals(true);
      try {
        const warmupResponse = await fetch(`${NEURAL_LABS_API_PREFIX}/warmup`, {
          method: "POST",
        });
        if (!warmupResponse.ok) {
          throw new Error(await getFetchErrorMessage(warmupResponse));
        }

        const warmupPayload = (await warmupResponse.json()) as WarmupResponse;
        if (!isCancelled) {
          await reconcileLiveTerminals(warmupPayload.terminal_id);
        }
      } catch (error) {
        if (!isCancelled) {
          toast.error(
            `Unable to initialize terminal workspace: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
          setLayout({ tabs: [], active_tab_id: "" });
        }
      } finally {
        if (!isCancelled) {
          setIsInitializingTerminals(false);
        }
      }
    };

    void initialize();

    return () => {
      isCancelled = true;
    };
  }, [hasLoadedUiMode, isDesktopModeActive, reconcileLiveTerminals]);

  useEffect(() => {
    if (!layout) {
      return;
    }
    persistLayout(layout);
  }, [layout]);

  const activeTab = useMemo(() => {
    if (!layout) {
      return null;
    }
    return (
      layout.tabs.find((tab) => tab.tab_id === layout.active_tab_id) ?? null
    );
  }, [layout]);

  const activePane = useMemo(() => {
    if (!activeTab) {
      return null;
    }
    return (
      activeTab.panes.find(
        (pane) => pane.pane_id === activeTab.active_pane_id
      ) ??
      activeTab.panes[0] ??
      null
    );
  }, [activeTab]);

  const activeTerminalId = activePane?.terminal_id ?? null;

  useEffect(() => {
    if (!hasLoadedUiMode || isDesktopModeActive || isInitializingTerminals) {
      return;
    }

    let cancelled = false;

    const refreshLiveTerminals = async () => {
      try {
        await reconcileLiveTerminals(activeTerminalId);
      } catch {
        // Ignore background refresh failures and keep the current layout visible.
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden || cancelled) {
        return;
      }
      void refreshLiveTerminals();
    };

    window.addEventListener("focus", handleVisibilityChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", handleVisibilityChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    activeTerminalId,
    hasLoadedUiMode,
    isDesktopModeActive,
    isInitializingTerminals,
    reconcileLiveTerminals,
  ]);

  useEffect(() => {
    if (
      !hasLoadedUiMode ||
      isDesktopModeActive ||
      isInitializingTerminals ||
      !activeTerminalId
    ) {
      setActiveTerminalStatus(null);
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;

    const pollStatus = async () => {
      try {
        const response = await fetch(
          `${NEURAL_LABS_API_PREFIX}/terminal/status?terminal_id=${encodeURIComponent(
            activeTerminalId
          )}`
        );
        if (response.status === 404) {
          if (!cancelled) {
            setActiveTerminalStatus({
              terminal_id: activeTerminalId,
              state: "exited",
              alive: false,
              created_at_epoch: 0,
              first_output_at_epoch: null,
              last_activity_epoch: 0,
              has_output: false,
            });
            void reconcileLiveTerminals(activeTerminalId);
          }
          if (intervalId !== null) {
            window.clearInterval(intervalId);
            intervalId = null;
          }
          return;
        }
        if (!response.ok) {
          throw new Error(await getFetchErrorMessage(response));
        }

        const payload = (await response.json()) as TerminalStatusResponse;
        if (!cancelled) {
          setActiveTerminalStatus(payload);
        }

        if (payload.state === "ready" || payload.state === "exited") {
          if (intervalId !== null) {
            window.clearInterval(intervalId);
            intervalId = null;
          }
        }
      } catch {
        if (!cancelled) {
          setActiveTerminalStatus(null);
        }
      }
    };

    void pollStatus();
    intervalId = window.setInterval(() => {
      void pollStatus();
    }, 1200);

    return () => {
      cancelled = true;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [
    activeTerminalId,
    hasLoadedUiMode,
    isDesktopModeActive,
    isInitializingTerminals,
    reconcileLiveTerminals,
  ]);

  const pathLabel = useMemo(() => {
    return currentPath ? `~/${currentPath}` : "~";
  }, [currentPath]);

  const canSplitActiveTab = Boolean(activeTab && activeTab.panes.length === 1);
  const environmentStatus = useMemo(() => {
    if (isInitializingTerminals || !activeTerminalId) {
      return {
        label: "Environment: Initializing",
        dotClass: "bg-yellow-500",
      };
    }

    const state = activeTerminalStatus?.state;
    if (state === "ready") {
      return {
        label: "Environment: Ready",
        dotClass: "bg-green-500",
      };
    }
    if (state === "exited") {
      return {
        label: "Environment: Exited",
        dotClass: "bg-red-500",
      };
    }
    return {
      label: "Environment: Initializing",
      dotClass: "bg-yellow-500",
    };
  }, [activeTerminalId, activeTerminalStatus?.state, isInitializingTerminals]);

  const currentDesktopBackground = useMemo(() => {
    if (isDesktopBackgroundPresetId(desktopBackgroundId)) {
      const preset =
        DESKTOP_BACKGROUND_PRESETS.find(
          (candidate) => candidate.id === desktopBackgroundId
        ) ?? DESKTOP_BACKGROUND_PRESETS[0]!;

      return {
        name: preset.name,
        desktopClassName: preset.desktopClassName,
        desktopStyle: undefined,
      };
    }

    const customPath =
      getCustomDesktopBackgroundPath(desktopBackgroundId) ||
      desktopCustomBackgroundPath;
    if (customPath) {
      return {
        name: "Custom Upload",
        desktopClassName: "bg-[#060b16] bg-cover bg-center",
        desktopStyle: {
          backgroundImage: `url(${getDesktopBackgroundContentUrl(customPath)})`,
        },
      };
    }

    return {
      name: DESKTOP_BACKGROUND_PRESETS[2]!.name,
      desktopClassName: DESKTOP_BACKGROUND_PRESETS[2]!.desktopClassName,
      desktopStyle: undefined,
    };
  }, [desktopBackgroundId, desktopCustomBackgroundPath]);

  const desktopWindowContent = useCallback(
    (windowState: DesktopWindowState) => {
      if (windowState.app_kind === "file-explorer") {
        const explorerState =
          desktopExplorerStates[windowState.id] ??
          createDefaultDesktopExplorerState();
        const explorerCurrentPath = explorerState.current_path;
        const explorerEntries = treeEntries[explorerCurrentPath] ?? [];
        const rootEntries = treeEntries[""] ?? [];

        return (
          <NeuralLabsDesktopFileExplorer
            currentPath={explorerCurrentPath}
            entries={explorerEntries}
            rootEntries={rootEntries}
            selectedPaths={explorerState.selected_paths}
            anchorPath={explorerState.anchor_path}
            viewMode={explorerState.view_mode}
            isLoading={loadingPaths.includes(explorerCurrentPath)}
            canGoBack={explorerState.back_history.length > 0}
            canGoForward={explorerState.forward_history.length > 0}
            canGoUp={Boolean(explorerCurrentPath)}
            canPreviewEntry={isPreviewable}
            onNavigateBack={() => navigateDesktopExplorerBack(windowState.id)}
            onNavigateForward={() =>
              navigateDesktopExplorerForward(windowState.id)
            }
            onNavigateUp={() => navigateDesktopExplorerUp(windowState.id)}
            onNavigateToPath={(path) =>
              navigateDesktopExplorerToPath(windowState.id, path)
            }
            onRefreshDirectory={() =>
              refreshDirectoryPaths([explorerCurrentPath], { silent: true })
            }
            onCreateFolder={async () => {
              const createdPath = await createFolderAtPath(explorerCurrentPath);
              if (createdPath) {
                setDesktopExplorerSelection(
                  windowState.id,
                  [createdPath],
                  createdPath
                );
              }
            }}
            onUploadFiles={async (files, destinationPath) => {
              await uploadFilesToPath(files, destinationPath);
              if (destinationPath === explorerCurrentPath) {
                setDesktopExplorerSelection(windowState.id, [], null);
              }
            }}
            onSelectionChange={(paths, anchorPath) =>
              setDesktopExplorerSelection(windowState.id, paths, anchorPath)
            }
            onSetViewMode={(mode) =>
              updateDesktopExplorerState(windowState.id, {
                view_mode: mode,
              })
            }
            onOpenEntry={(entry) => {
              if (entry.is_directory) {
                void navigateDesktopExplorerToPath(windowState.id, entry.path);
                return;
              }
              if (isPreviewable(entry)) {
                openPreview(entry, { syncLegacySelection: false });
              }
            }}
            onPreviewEntry={(entry) =>
              openPreview(entry, { syncLegacySelection: false })
            }
            onDownloadEntry={downloadFile}
            onCopyPath={copyPath}
            onRenameEntry={async (entry) => {
              const renamedPath = await renameEntryAtPath(entry);
              if (!renamedPath) {
                return;
              }
              updateDesktopExplorerState(windowState.id, (currentState) => ({
                ...currentState,
                current_path: replacePathPrefix(
                  currentState.current_path,
                  entry.path,
                  renamedPath
                ),
                selected_paths: [renamedPath],
                anchor_path: renamedPath,
              }));
            }}
            onDeleteEntry={async (entry) => {
              const didDelete = await deleteEntryAtPath(entry);
              if (!didDelete) {
                return;
              }
              updateDesktopExplorerState(windowState.id, (currentState) => {
                const nextPath =
                  currentState.current_path === entry.path ||
                  currentState.current_path.startsWith(`${entry.path}/`)
                    ? getParentPath(entry.path)
                    : currentState.current_path;
                if (nextPath !== currentState.current_path) {
                  void loadDirectory(nextPath);
                }
                return {
                  ...currentState,
                  current_path: nextPath,
                  selected_paths: currentState.selected_paths.filter(
                    (path) =>
                      path !== entry.path && !path.startsWith(`${entry.path}/`)
                  ),
                  anchor_path:
                    currentState.anchor_path === entry.path
                      ? null
                      : currentState.anchor_path,
                };
              });
            }}
            onMoveEntries={async (entriesToMove, destinationPath) => {
              const movedPaths = await moveEntries(
                entriesToMove,
                destinationPath
              );
              setDesktopExplorerSelection(
                windowState.id,
                movedPaths,
                movedPaths[movedPaths.length - 1] ?? null
              );
            }}
          />
        );
      }

      if (windowState.app_kind === "desktop-settings") {
        return (
          <NeuralLabsDesktopSettingsPanel
            selectedBackgroundId={desktopBackgroundId}
            customBackgroundPath={desktopCustomBackgroundPath}
            onSelectBackground={setDesktopBackgroundId}
            onSelectCustomBackground={selectCustomBackground}
            onUploadCustomBackground={uploadCustomBackground}
            onDeleteCustomBackground={deleteCustomBackground}
            isUploadingCustomBackground={isUploadingCustomBackground}
            isDeletingCustomBackground={isDeletingCustomBackground}
          />
        );
      }

      if (windowState.app_kind === "text-editor") {
        const editorState =
          desktopEditorStates[windowState.id] ??
          createDefaultDesktopEditorWindowState();

        return (
          <NeuralLabsDesktopTextEditor
            windowState={editorState}
            currentDirectory={currentPath}
            onToggleSidebar={() => toggleDesktopEditorSidebar(windowState.id)}
            onCreateScratchTab={() =>
              addDesktopEditorScratchTab(windowState.id)
            }
            onSetActiveTab={(tabId) =>
              setActiveDesktopEditorTab(windowState.id, tabId)
            }
            onCloseTab={(tabId) => closeDesktopEditorTab(windowState.id, tabId)}
            onChangeTabContent={(tabId, content) =>
              updateDesktopEditorTabContent(windowState.id, tabId, content)
            }
            onSaveTab={(tabId) => saveDesktopEditorTab(windowState.id, tabId)}
            onSaveTabAs={(tabId, targetPath) =>
              saveDesktopEditorTabAs(windowState.id, tabId, targetPath)
            }
            onReloadTab={(tabId) =>
              reloadDesktopEditorTab(windowState.id, tabId)
            }
          />
        );
      }

      const terminalState =
        desktopTerminalStates[windowState.id] ??
        createDefaultDesktopTerminalWindowState();

      return (
        <NeuralLabsDesktopTerminal
          layout={terminalState.layout}
          isInitializing={terminalState.is_initializing}
          onAddTab={() => addDesktopTerminalTab(windowState.id)}
          onSetActiveTab={(tabId) =>
            setActiveDesktopTerminalTab(windowState.id, tabId)
          }
          onSetActivePane={(tabId, paneId) =>
            setActiveDesktopTerminalPane(windowState.id, tabId, paneId)
          }
          onCloseTab={(tabId) => closeDesktopTerminalTab(windowState.id, tabId)}
          onClosePane={(tabId, paneId) =>
            closeDesktopTerminalPane(windowState.id, tabId, paneId)
          }
          onSplitTab={(tabId, direction) =>
            splitDesktopTerminalTab(windowState.id, tabId, direction)
          }
          onDuplicateTab={(tabId) =>
            duplicateDesktopTerminalTab(windowState.id, tabId)
          }
          onRenameTab={(tabId) =>
            renameDesktopTerminalTab(windowState.id, tabId)
          }
          onMoveTabToNewWindow={(tabId) =>
            moveDesktopTerminalTabToNewWindow(windowState.id, tabId)
          }
          onReorderTabs={(sourceTabId, targetTabId) =>
            reorderDesktopTerminalTabs(windowState.id, sourceTabId, targetTabId)
          }
          renderTerminalPane={(pane, isActive, onFocus) => (
            <TerminalPane
              terminalId={pane.terminal_id}
              isActive={isActive}
              onFocus={onFocus}
            />
          )}
        />
      );
    },
    [
      addDesktopTerminalTab,
      closeDesktopTerminalPane,
      closeDesktopTerminalTab,
      copyPath,
      createFolderAtPath,
      downloadFile,
      desktopExplorerStates,
      desktopTerminalStates,
      environmentStatus,
      deleteEntryAtPath,
      duplicateDesktopTerminalTab,
      isPreviewable,
      loadingPaths,
      loadDirectory,
      addDesktopEditorScratchTab,
      moveEntries,
      moveDesktopTerminalTabToNewWindow,
      navigateDesktopExplorerBack,
      navigateDesktopExplorerForward,
      navigateDesktopExplorerToPath,
      navigateDesktopExplorerUp,
      openPreview,
      reorderDesktopTerminalTabs,
      renameDesktopTerminalTab,
      refreshDirectoryPaths,
      reloadDesktopEditorTab,
      renameEntryAtPath,
      saveDesktopEditorTab,
      saveDesktopEditorTabAs,
      setDesktopExplorerSelection,
      setActiveDesktopEditorTab,
      setActiveDesktopTerminalPane,
      setActiveDesktopTerminalTab,
      desktopBackgroundId,
      splitDesktopTerminalTab,
      treeEntries,
      uploadFilesToPath,
      updateDesktopEditorTabContent,
      updateDesktopExplorerState,
      toggleDesktopEditorSidebar,
    ]
  );

  const handleTaskbarContextMenu = useCallback(
    (
      event: ReactMouseEvent<HTMLButtonElement>,
      appKind: TaskbarMenuState["appKind"]
    ) => {
      event.preventDefault();
      setTaskbarMenu({ appKind, x: event.clientX, y: event.clientY });
    },
    []
  );

  const activateTaskbarDesktopApp = useCallback(
    (appKind: DesktopWindowState["app_kind"]) => {
      const latestWindow = [...desktopWindows]
        .filter((windowState) => windowState.app_kind === appKind)
        .sort((left, right) => right.z_index - left.z_index)[0];

      if (!latestWindow) {
        openDesktopApp(appKind);
        return;
      }

      focusDesktopWindow(latestWindow.id);
    },
    [desktopWindows, focusDesktopWindow, openDesktopApp]
  );

  if (isDesktopModeActive) {
    const textEditorWindows = desktopWindows.filter(
      (windowState) => windowState.app_kind === "text-editor"
    );
    const hasTextEditorWindow = textEditorWindows.length > 0;
    const hasVisibleTextEditorWindow = textEditorWindows.some(
      (windowState) => !windowState.is_minimized
    );
    const fileExplorerWindows = desktopWindows.filter(
      (windowState) => windowState.app_kind === "file-explorer"
    );
    const terminalWindows = desktopWindows.filter(
      (windowState) => windowState.app_kind === "terminal-workspace"
    );
    const settingsWindows = desktopWindows.filter(
      (windowState) => windowState.app_kind === "desktop-settings"
    );
    const hasFileExplorerWindow = fileExplorerWindows.length > 0;
    const hasVisibleFileExplorerWindow = fileExplorerWindows.some(
      (windowState) => !windowState.is_minimized
    );
    const hasTerminalWindow = terminalWindows.length > 0;
    const hasVisibleTerminalWindow = terminalWindows.some(
      (windowState) => !windowState.is_minimized
    );
    const hasSettingsWindow = settingsWindows.length > 0;
    const hasVisibleSettingsWindow = settingsWindows.some(
      (windowState) => !windowState.is_minimized
    );

    return (
      <div className="relative h-[100dvh] w-full overflow-hidden bg-[#060b16] text-white">
        <div
          className={`absolute inset-0 ${currentDesktopBackground.desktopClassName}`}
          style={currentDesktopBackground.desktopStyle}
        />
        <div className="absolute inset-x-0 top-0 h-40 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),transparent)]" />

        <div className="relative z-10 flex h-full flex-col">
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <SvgTerminal className="h-4 w-4 shrink-0 stroke-white" />
                <Text className="text-sm font-medium uppercase tracking-[0.22em] text-white/80">
                  Neural Labs Desktop
                </Text>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-1 rounded-full border border-white/15 bg-white/8 px-3 py-1.5 md:flex">
                <span
                  className={`h-2 w-2 rounded-full ${environmentStatus.dotClass}`}
                />
                <Text className="whitespace-nowrap text-sm text-white/80">
                  {environmentStatus.label}
                </Text>
              </div>
              <Button
                tertiary
                size="md"
                leftIcon={SvgArrowLeft}
                className="!border-white/15 !bg-white/10"
                onClick={() => router.push("/app")}
              >
                Back to Main Chat
              </Button>
            </div>
          </div>

          <div
            ref={previewWorkspaceRef}
            className="relative min-h-0 flex-1 overflow-hidden px-4 pb-28"
          >
            <NeuralLabsDesktopWindows
              windows={desktopWindows}
              workspaceBounds={workspaceBounds}
              onCloseWindow={closeDesktopWindow}
              onFocusWindow={focusDesktopWindow}
              onMinimizeWindow={minimizeDesktopWindow}
              onUpdateWindow={updateDesktopWindow}
              renderWindowContent={desktopWindowContent}
            />

            <NeuralLabsPreviewWindows
              windows={previewWindows}
              workspaceBounds={workspaceBounds}
              onCloseWindow={closePreviewWindow}
              onFocusWindow={focusPreviewWindow}
              onUpdateWindow={updatePreviewWindow}
            />
          </div>

          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-white/15 bg-[#0a1220]/88 px-3 py-2 shadow-[0_18px_48px_rgba(0,0,0,0.35)] backdrop-blur-xl">
              <IconActionButton label="File Explorer">
                <button
                  type="button"
                  aria-label="File Explorer"
                  className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
                    hasVisibleFileExplorerWindow
                      ? "bg-white/16 text-white"
                      : hasFileExplorerWindow
                        ? "bg-white/8 text-white/80 ring-1 ring-white/20"
                        : "text-white/80 hover:bg-white/10"
                  }`}
                  onClick={() => activateTaskbarDesktopApp("file-explorer")}
                  onContextMenu={(event) =>
                    handleTaskbarContextMenu(event, "file-explorer")
                  }
                >
                  <SvgFolder className="h-5 w-5 shrink-0 stroke-current" />
                </button>
              </IconActionButton>
              <IconActionButton label="Terminal">
                <button
                  type="button"
                  aria-label="Terminal"
                  className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
                    hasVisibleTerminalWindow
                      ? "bg-white/16 text-white"
                      : hasTerminalWindow
                        ? "bg-white/8 text-white/80 ring-1 ring-white/20"
                        : "text-white/80 hover:bg-white/10"
                  }`}
                  onClick={() =>
                    activateTaskbarDesktopApp("terminal-workspace")
                  }
                  onContextMenu={(event) =>
                    handleTaskbarContextMenu(event, "terminal-workspace")
                  }
                >
                  <SvgTerminal className="h-5 w-5 shrink-0 stroke-current" />
                </button>
              </IconActionButton>
              <IconActionButton label="Text Editor">
                <button
                  type="button"
                  aria-label="Text Editor"
                  className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
                    hasVisibleTextEditorWindow
                      ? "bg-white/16 text-white"
                      : hasTextEditorWindow
                        ? "bg-white/8 text-white/80 ring-1 ring-white/20"
                        : "text-white/80 hover:bg-white/10"
                  }`}
                  onClick={focusOrRestoreLatestTextEditor}
                  onContextMenu={(event) =>
                    handleTaskbarContextMenu(event, "text-editor")
                  }
                >
                  <SvgFileText className="h-5 w-5 shrink-0 stroke-current" />
                </button>
              </IconActionButton>
              <div className="mx-1 h-8 w-px bg-white/12" />
              <IconActionButton label="Desktop Settings">
                <button
                  type="button"
                  aria-label="Desktop Settings"
                  className={`flex h-11 w-11 items-center justify-center rounded-full transition ${
                    hasVisibleSettingsWindow
                      ? "bg-white/16 text-white"
                      : hasSettingsWindow
                        ? "bg-white/8 text-white/80 ring-1 ring-white/20"
                        : "text-white/80 hover:bg-white/10"
                  }`}
                  onClick={() => activateTaskbarDesktopApp("desktop-settings")}
                >
                  <SvgSettings className="h-5 w-5 shrink-0 stroke-current" />
                </button>
              </IconActionButton>
            </div>
          </div>

          {taskbarMenu ? (
            <div
              className="absolute z-30 min-w-[11rem] rounded-16 border border-white/12 bg-[#0b1320]/96 p-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.45)] backdrop-blur-xl"
              style={{
                left: Math.max(16, taskbarMenu.x - 16),
                top: Math.max(16, taskbarMenu.y - 72),
              }}
            >
              {(taskbarMenu.appKind === "terminal-workspace" ||
                taskbarMenu.appKind === "file-explorer" ||
                taskbarMenu.appKind === "text-editor") && (
                <button
                  type="button"
                  className="flex w-full items-center rounded-12 px-3 py-2 text-left text-sm text-white/85 transition hover:bg-white/10"
                  onClick={() => {
                    if (taskbarMenu.appKind === "text-editor") {
                      openTextEditorApp({ forceNew: true });
                    } else {
                      openDesktopApp(taskbarMenu.appKind, { forceNew: true });
                    }
                    setTaskbarMenu(null);
                  }}
                >
                  New Window
                </button>
              )}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-full bg-background-neutral-01 p-3 md:p-4">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-16 border border-border-01 bg-background-neutral-02">
        <div className="flex items-center justify-between gap-2 border-b border-border-01 bg-background-neutral-01 p-2">
          <div className="min-w-0 flex items-center gap-2">
            <Button
              tertiary
              size="md"
              leftIcon={SvgArrowLeft}
              onClick={() => router.push("/app")}
            >
              Back to Main Chat
            </Button>
            <div className="h-4 w-px bg-border-02" />
            <SvgTerminal className="h-4 w-4 shrink-0 stroke-text-03" />
            <Text mainUiAction className="truncate">
              Neural Labs
            </Text>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-08 border border-border-01 px-2 py-1">
              <span
                className={`h-2 w-2 rounded-full ${environmentStatus.dotClass}`}
              />
              <Text text03 className="whitespace-nowrap">
                {environmentStatus.label}
              </Text>
            </div>
            <Button tertiary size="md" onClick={() => void addTab()}>
              New Terminal
            </Button>
            <Button
              tertiary
              size="md"
              disabled={!canSplitActiveTab}
              onClick={() => void splitActiveTab("vertical")}
            >
              Split Vertical
            </Button>
            <Button
              tertiary
              size="md"
              disabled={!canSplitActiveTab}
              onClick={() => void splitActiveTab("horizontal")}
            >
              Split Horizontal
            </Button>
          </div>
        </div>

        <div
          ref={workspaceSplitRef}
          className={`relative min-h-0 flex-1 flex flex-col md:flex-row ${
            isResizingNavigator ? "cursor-col-resize select-none" : ""
          }`}
        >
          {isNavigatorVisible ? (
            <aside
              className="flex min-h-0 w-full flex-col border-b border-border-01 md:w-auto md:shrink-0 md:border-b-0"
              style={
                isDesktopLayout ? { width: `${navigatorWidth}px` } : undefined
              }
            >
              <NeuralLabsFileExplorerPanel
                currentPath={currentPath}
                pathLabel={pathLabel}
                treeEntries={treeEntries}
                expandedPaths={expandedPaths}
                loadingPaths={loadingPaths}
                selectedPath={selectedPath}
                isPreviewable={isPreviewable}
                fileUploadInputRef={fileUploadInputRef}
                onSelectEntry={selectEntry}
                onToggleDirectory={toggleDirectory}
                onActivateEntry={activateTreeEntry}
                onPreviewEntry={openPreview}
                onDownloadEntry={downloadFile}
                onCopyPath={copyPath}
                onRenameEntry={renamePath}
                onDeleteEntry={deletePath}
                onMoveEntry={moveEntry}
                onUploadFiles={uploadFilesToPath}
                onUploadInputChange={uploadFile}
                onNavigateUp={navigateUp}
                onCreateFolder={createFolder}
                onRefreshDirectory={refreshDirectory}
                onTriggerUpload={triggerUpload}
                onActivateTextEditor={openTextEditorApp}
                showNeuralAppsPanel
              />
            </aside>
          ) : isDesktopLayout ? (
            <aside
              className="hidden md:flex md:shrink-0 flex-col items-center gap-2 border-r border-border-01 bg-background-neutral-01 px-2 py-2"
              style={{ width: `${COLLAPSED_NAVIGATOR_RAIL_PX}px` }}
            >
              <IconActionButton label="Expand file navigator">
                <Button
                  tertiary
                  size="md"
                  aria-label="Expand file navigator"
                  onClick={() => setIsNavigatorCollapsed(false)}
                >
                  <SvgChevronRight className="h-4 w-4 stroke-text-03" />
                </Button>
              </IconActionButton>
              <SvgFolder className="h-4 w-4 shrink-0 stroke-text-03" />
              <IconActionButton label="Up">
                <Button
                  tertiary
                  size="md"
                  leftIcon={SvgChevronLeft}
                  aria-label="Up"
                  disabled={!currentPath}
                  onClick={() => void navigateUp()}
                />
              </IconActionButton>
              <IconActionButton label="New folder">
                <Button
                  tertiary
                  size="md"
                  leftIcon={SvgFolderPlus}
                  aria-label="New folder"
                  onClick={() => void createFolder()}
                />
              </IconActionButton>
              <IconActionButton label="Upload files">
                <Button
                  tertiary
                  size="md"
                  leftIcon={SvgUploadCloud}
                  aria-label="Upload files"
                  onClick={triggerUpload}
                />
              </IconActionButton>
              <IconActionButton label="Refresh files">
                <Button
                  tertiary
                  size="md"
                  leftIcon={SvgRefreshCw}
                  aria-label="Refresh files"
                  onClick={() => void refreshDirectory()}
                />
              </IconActionButton>
              <div className="h-px w-6 bg-border-01" />
              <IconActionButton label="Text Editor">
                <Button
                  tertiary
                  size="md"
                  leftIcon={SvgFileText}
                  aria-label="Text Editor"
                  onClick={() => openTextEditorApp()}
                />
              </IconActionButton>
            </aside>
          ) : null}

          {isNavigatorVisible ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize file navigator"
              className={`hidden md:flex w-2 shrink-0 cursor-col-resize items-stretch justify-center ${
                isResizingNavigator
                  ? "bg-background-neutral-03"
                  : "hover:bg-background-neutral-03/50"
              }`}
              onPointerDown={beginResizeNavigator}
            >
              <div
                className={`w-px ${
                  isResizingNavigator ? "bg-border-04" : "bg-border-01"
                }`}
              />
            </div>
          ) : null}

          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div
              ref={previewWorkspaceRef}
              className="relative min-h-0 flex flex-1"
            >
              <NeuralLabsTerminalWorkspacePanel
                layout={layout}
                activeTab={activeTab}
                activePane={activePane}
                isInitializingTerminals={isInitializingTerminals}
                environmentStatus={environmentStatus}
                canSplitActiveTab={canSplitActiveTab}
                onAddTab={addTab}
                onSplitActiveTab={splitActiveTab}
                onSetActiveTab={setActiveTab}
                onSetActivePane={setActivePane}
                onCloseTabById={closeTabById}
                onClosePaneById={closePaneById}
                isTerminalNavigatorVisible={isTerminalNavigatorVisible}
                onCollapseTerminalNavigator={() =>
                  setIsTerminalNavigatorCollapsed(true)
                }
                overlayChildren={
                  <NeuralLabsPreviewWindows
                    windows={previewWindows}
                    workspaceBounds={workspaceBounds}
                    onCloseWindow={closePreviewWindow}
                    onFocusWindow={focusPreviewWindow}
                    onUpdateWindow={updatePreviewWindow}
                  />
                }
              />

              {!isTerminalNavigatorVisible && isDesktopLayout ? (
                <aside
                  className="hidden md:flex md:shrink-0 flex-col items-center gap-2 border-l border-border-01 bg-background-neutral-01 px-2 py-2"
                  style={{ width: `${COLLAPSED_NAVIGATOR_RAIL_PX}px` }}
                >
                  <IconActionButton label="Expand terminal navigator">
                    <Button
                      tertiary
                      size="md"
                      aria-label="Expand terminal navigator"
                      onClick={() => setIsTerminalNavigatorCollapsed(false)}
                    >
                      <SvgChevronLeft className="h-4 w-4 stroke-text-03" />
                    </Button>
                  </IconActionButton>
                  <SvgTerminal className="h-4 w-4 shrink-0 stroke-text-03" />
                </aside>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
