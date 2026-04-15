"use client";

import "@xterm/xterm/css/xterm.css";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import Button from "@/refresh-components/buttons/Button";
import Text from "@/refresh-components/texts/Text";
import { toast } from "@/hooks/useToast";
import CodexLabsFileTree from "@/app/codex-labs/CodexLabsFileTree";
import CodexLabsPreviewWindows from "@/app/codex-labs/CodexLabsPreviewWindows";
import type {
  CodexLabsFileEntry,
  DirectoryResponse,
  PreviewKind,
  PreviewWindowState,
} from "@/app/codex-labs/types";
import {
  SvgArrowLeft,
  SvgChevronLeft,
  SvgChevronRight,
  SvgFolder,
  SvgFolderPlus,
  SvgRefreshCw,
  SvgTerminal,
  SvgX,
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

type SplitMode = "none" | "horizontal" | "vertical";

interface PaneState {
  pane_id: string;
  terminal_id: string;
}

interface TabState {
  tab_id: string;
  title: string;
  split_mode: SplitMode;
  panes: PaneState[];
  active_pane_id: string;
}

interface TerminalLayoutState {
  tabs: TabState[];
  active_tab_id: string;
}

interface PersistedTerminalLayout {
  tabs: TabState[];
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

const CODEX_LABS_API_PREFIX = "/api/codex-labs";
const CODEX_LABS_TERMINAL_WS_PATH = "/ws/codex-labs/terminal";
const LAYOUT_STORAGE_KEY = "codex-labs-layout-v1";
const TREE_STATE_STORAGE_KEY = "codex-labs-tree-v1";
const PREVIEW_WINDOWS_STORAGE_KEY = "codex-labs-previews-v1";
const NAVIGATOR_WIDTH_STORAGE_KEY = "codex-labs-navigator-width-v1";
const NAVIGATOR_COLLAPSED_STORAGE_KEY = "codex-labs-navigator-collapsed-v1";
const TREE_AUTO_SYNC_INTERVAL_MS = 1500;
const DEFAULT_NAVIGATOR_WIDTH_PX = 420;
const MIN_NAVIGATOR_WIDTH_PX = 260;
const MAX_NAVIGATOR_WIDTH_PX = 860;
const MAX_NAVIGATOR_WIDTH_RATIO = 0.7;
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

function getPreviewKind(entry: CodexLabsFileEntry): PreviewKind | null {
  const lowerName = entry.name.toLowerCase();
  const mimeType = entry.mime_type?.toLowerCase() ?? "";
  const extension = lowerName.includes(".")
    ? `.${lowerName.split(".").pop()}`
    : "";

  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType === "text/html" || lowerName.endsWith(".html") || lowerName.endsWith(".htm")) {
    return "html";
  }
  if (PDF_PREVIEW_MIME_TYPES.has(mimeType) || PDF_PREVIEW_EXTENSIONS.has(extension)) {
    return "pdf";
  }
  if (KMZ_PREVIEW_MIME_TYPES.has(mimeType) || KMZ_PREVIEW_EXTENSIONS.has(extension)) {
    return "kmz";
  }
  if (XLSX_PREVIEW_MIME_TYPES.has(mimeType) || XLSX_PREVIEW_EXTENSIONS.has(extension)) {
    return "xlsx";
  }

  if (mimeType.startsWith("text/") || TEXT_PREVIEW_MIME_TYPES.has(mimeType)) {
    return "text";
  }

  if (TEXT_PREVIEW_EXTENSIONS.has(extension)) {
    return "text";
  }
  if (TEXT_PREVIEW_FILENAMES.has(lowerName)) {
    return "text";
  }
  return null;
}

function isPreviewable(entry: CodexLabsFileEntry): boolean {
  return getPreviewKind(entry) !== null;
}

function triggerBrowserDownload(path: string, name: string): void {
  const anchor = document.createElement("a");
  anchor.href = `${CODEX_LABS_API_PREFIX}/files/download?path=${encodeURIComponent(path)}`;
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

function getSplitModeLabel(splitMode: SplitMode): string {
  if (splitMode === "vertical") {
    return "Vertical split";
  }
  if (splitMode === "horizontal") {
    return "Horizontal split";
  }
  return "Single terminal";
}

function createTabFromTerminal(terminalId: string, existingTabs: TabState[]): TabState {
  const tabId = createLocalId();
  const paneId = createLocalId();
  return {
    tab_id: tabId,
    title: `Terminal ${existingTabs.length + 1}`,
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

function reconcileLayout(
  savedLayout: PersistedTerminalLayout | null,
  terminalIds: string[]
): TerminalLayoutState {
  const available = new Set(terminalIds);
  const used = new Set<string>();
  const reconciledTabs: TabState[] = [];

  if (savedLayout) {
    for (const savedTab of savedLayout.tabs) {
      const panes = savedTab.panes.filter((pane) => available.has(pane.terminal_id));
      if (panes.length === 0) {
        continue;
      }

      panes.forEach((pane) => used.add(pane.terminal_id));
      const splitMode: SplitMode = panes.length === 2 ? savedTab.split_mode : "none";
      const activePaneId = panes.some((pane) => pane.pane_id === savedTab.active_pane_id)
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
    savedLayout && reconciledTabs.some((tab) => tab.tab_id === savedLayout.active_tab_id)
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
    if (!Array.isArray(parsed.tabs) || typeof parsed.active_tab_id !== "string") {
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

    return parsed.filter((entry): entry is PreviewWindowState => {
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
        (candidate.snapped_zone === null || typeof candidate.snapped_zone === "string")
      );
    });
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

function TerminalPane({ terminalId, isActive, onFocus }: TerminalPaneProps) {
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

  const sendTerminalInput = useCallback(async (data: string) => {
    if (!data) {
      return;
    }

    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(data);
      return;
    }

    await fetch(`${CODEX_LABS_API_PREFIX}/terminal/input`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ terminal_id: terminalId, data }),
    });
  }, [terminalId]);

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

    await fetch(`${CODEX_LABS_API_PREFIX}/terminal/resize`, {
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

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
      theme: {
        background: "#111317",
      },
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
        const tokenResponse = await fetch(`${CODEX_LABS_API_PREFIX}/terminal/ws-token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ terminal_id: terminalId }),
        });

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
          `${CODEX_LABS_TERMINAL_WS_PATH}?token=${encodeURIComponent(
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
                  typeof payload.code === "number" ? ` with code ${payload.code}` : ""
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
    };
  }, [
    copyTerminalSelection,
    flushTerminalInput,
    pasteClipboardText,
    resizeTerminal,
    sendTerminalInput,
    terminalId,
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
      <div ref={hostRef} className="h-full w-full p-1.5" />
    </div>
  );
}

export default function CodexLabsPage() {
  const router = useRouter();
  const [currentPath, setCurrentPath] = useState("");
  const [treeEntries, setTreeEntries] = useState<Record<string, CodexLabsFileEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<string[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [previewWindows, setPreviewWindows] = useState<PreviewWindowState[]>([]);
  const [workspaceBounds, setWorkspaceBounds] = useState({ width: 0, height: 0 });
  const [layout, setLayout] = useState<TerminalLayoutState | null>(null);
  const [isInitializingTerminals, setIsInitializingTerminals] = useState(true);
  const [activeTerminalStatus, setActiveTerminalStatus] =
    useState<TerminalStatusResponse | null>(null);
  const [navigatorWidth, setNavigatorWidth] = useState(DEFAULT_NAVIGATOR_WIDTH_PX);
  const [isDesktopLayout, setIsDesktopLayout] = useState(false);
  const [isResizingNavigator, setIsResizingNavigator] = useState(false);
  const [isNavigatorCollapsed, setIsNavigatorCollapsed] = useState(false);

  const layoutRef = useRef<TerminalLayoutState | null>(null);
  const fileUploadInputRef = useRef<HTMLInputElement | null>(null);
  const previewWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const workspaceSplitRef = useRef<HTMLDivElement | null>(null);
  const highestPreviewZIndexRef = useRef(1);
  const treeSyncInFlightRef = useRef(false);

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

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
        const nextWidth = clampNavigatorWidth(moveEvent.clientX - splitBounds.left);
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
          previousPaths.includes(path) ? previousPaths : [...previousPaths, path]
        );
      }
      try {
        const response = await fetch(
          `${CODEX_LABS_API_PREFIX}/files?path=${encodeURIComponent(path)}`
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

  const refreshDirectory = useCallback(async (options?: DirectoryLoadOptions) => {
    const pathsToRefresh = new Set<string>(["", currentPath]);
    expandedPaths.forEach((path) => pathsToRefresh.add(path));

    await Promise.all(
      Array.from(pathsToRefresh)
        .filter((path) => path !== undefined)
        .map(async (path) => {
          await loadDirectory(path, options);
        })
    );
  }, [currentPath, expandedPaths, loadDirectory]);

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

  const selectEntry = useCallback((entry: CodexLabsFileEntry) => {
    setSelectedPath(entry.path);
    setCurrentPath(entry.is_directory ? entry.path : getParentPath(entry.path));
  }, []);

  const toggleDirectory = useCallback(
    (entry: CodexLabsFileEntry) => {
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
          ? { ...windowState, z_index: highestPreviewZIndexRef.current }
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

  const openPreview = useCallback(
    (entry: CodexLabsFileEntry) => {
      const previewKind = getPreviewKind(entry);
      if (!previewKind) {
        return;
      }

      setSelectedPath(entry.path);
      setCurrentPath(getParentPath(entry.path));
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
        },
      ]);
    },
    [focusPreviewWindow, previewWindows, workspaceBounds.height, workspaceBounds.width]
  );

  const createFolder = useCallback(async () => {
    const folderNameInput = window.prompt("New folder name");
    if (folderNameInput === null) {
      return;
    }
    const folderName = folderNameInput.trim();
    if (!folderName) {
      toast.error("Folder name cannot be empty");
      return;
    }

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

    const requestCreateDirectory = async (
      parentPath: string
    ): Promise<{ response: Response; message: string | null }> => {
      const response = await fetch(`${CODEX_LABS_API_PREFIX}/files/directory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parent_path: parentPath,
          name: folderName,
        }),
      });

      if (response.ok) {
        return { response, message: null };
      }

      return {
        response,
        message: await getFetchErrorMessage(response),
      };
    };

    let parentPath = resolveParentPath();
    let createResult = await requestCreateDirectory(parentPath);

    if (
      !createResult.response.ok &&
      parentPath &&
      (createResult.response.status === 404 ||
        (createResult.message ?? "").toLowerCase().includes("parent directory not found"))
    ) {
      parentPath = "";
      createResult = await requestCreateDirectory(parentPath);
      if (createResult.response.ok) {
        setCurrentPath("");
      }
    }

    if (!createResult.response.ok) {
      toast.error(createResult.message ?? "Unable to create folder");
      return;
    }

    try {
      const payload = (await createResult.response.json()) as { path?: string };
      if (typeof payload.path === "string") {
        setSelectedPath(payload.path);
      }
    } catch {
      // Ignore response parse failures for non-critical UI state updates.
    }

    await refreshDirectory();
  }, [currentPath, refreshDirectory, treeEntries]);

  const renamePath = useCallback(
    async (entry: CodexLabsFileEntry) => {
      const newName = window.prompt("Rename to:", entry.name);
      if (!newName || newName === entry.name) {
        return;
      }

      const response = await fetch(`${CODEX_LABS_API_PREFIX}/files/rename`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: entry.path, new_name: newName }),
      });

      if (!response.ok) {
        toast.error(await getFetchErrorMessage(response));
        return;
      }

      const payload = (await response.json()) as { path?: string };
      setSelectedPath(typeof payload.path === "string" ? payload.path : null);
      await refreshDirectory();
    },
    [refreshDirectory]
  );

  const deletePath = useCallback(
    async (entry: CodexLabsFileEntry) => {
      const confirmed = window.confirm(
        `Delete ${entry.is_directory ? "folder" : "file"} "${entry.name}"?`
      );
      if (!confirmed) {
        return;
      }

      const response = await fetch(
        `${CODEX_LABS_API_PREFIX}/files?path=${encodeURIComponent(entry.path)}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        toast.error(await getFetchErrorMessage(response));
        return;
      }

      setSelectedPath((previousPath) =>
        previousPath === entry.path ? null : previousPath
      );
      setPreviewWindows((previousWindows) =>
        previousWindows.filter((windowState) => windowState.path !== entry.path)
      );
      await refreshDirectory();
    },
    [refreshDirectory]
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

        const response = await fetch(`${CODEX_LABS_API_PREFIX}/files/upload`, {
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
          failedUploads.length > 3 ? ` and ${failedUploads.length - 3} more` : "";
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

      await refreshDirectory();
    },
    [refreshDirectory]
  );

  const uploadFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? Array.from(event.target.files) : [];
      event.target.value = "";
      await uploadFilesToPath(files, currentPath);
    },
    [currentPath, uploadFilesToPath]
  );

  const downloadFile = useCallback((entry: CodexLabsFileEntry) => {
    triggerBrowserDownload(entry.path, entry.name);
  }, []);

  const copyPath = useCallback(async (entry: CodexLabsFileEntry) => {
    const shellPath = entry.path ? `~/${entry.path}` : "~";
    try {
      await navigator.clipboard.writeText(shellPath);
      toast.success(`Copied path: ${shellPath}`);
    } catch {
      toast.error("Unable to copy path");
    }
  }, []);

  const moveEntry = useCallback(
    async (entry: CodexLabsFileEntry, destinationPath: string) => {
      if (getParentPath(entry.path) === destinationPath) {
        return;
      }

      const response = await fetch(`${CODEX_LABS_API_PREFIX}/files/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: entry.path,
          destination_parent_path: destinationPath,
        }),
      });

      if (!response.ok) {
        toast.error(await getFetchErrorMessage(response));
        return;
      }

      const payload = (await response.json()) as { path?: string };
      const movedPath =
        typeof payload.path === "string" ? payload.path : destinationPath;
      setSelectedPath(movedPath || null);
      setCurrentPath(destinationPath);
      if (destinationPath) {
        setExpandedPaths((previousPaths) =>
          previousPaths.includes(destinationPath)
            ? previousPaths
            : [...previousPaths, destinationPath]
        );
      }
      await refreshDirectory({ silent: true });
    },
    [refreshDirectory]
  );

  const activateTreeEntry = useCallback(
    (entry: CodexLabsFileEntry) => {
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
    void Promise.all(Array.from(pathsToLoad).map((path) => loadDirectory(path)));
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
  }, []);

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
    const response = await fetch(`${CODEX_LABS_API_PREFIX}/terminals`);
    if (!response.ok) {
      throw new Error(await getFetchErrorMessage(response));
    }
    const payload = (await response.json()) as TerminalListResponse;
    return payload.terminals.map((terminal) => terminal.terminal_id);
  }, []);

  const createTerminal = useCallback(async (): Promise<string> => {
    const response = await fetch(`${CODEX_LABS_API_PREFIX}/terminals`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(await getFetchErrorMessage(response));
    }
    const payload = (await response.json()) as TerminalDescriptor;
    return payload.terminal_id;
  }, []);

  const deleteTerminal = useCallback(async (terminalId: string) => {
    const response = await fetch(
      `${CODEX_LABS_API_PREFIX}/terminals/${encodeURIComponent(terminalId)}`,
      { method: "DELETE" }
    );

    if (response.status === 404 || response.status === 204) {
      return;
    }

    if (!response.ok) {
      throw new Error(await getFetchErrorMessage(response));
    }
  }, []);

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

      const tab = current.tabs.find((candidate) => candidate.tab_id === current.active_tab_id);
      if (!tab || tab.panes.length !== 1) {
        return;
      }

      try {
        const terminalId = await createTerminal();
        const newPane: PaneState = {
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
          await deleteTerminal(pane.terminal_id);
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

      const remainingTabs = nextLayout.tabs.filter((candidate) => candidate.tab_id !== tabId);
      if (remainingTabs.length === 0) {
        try {
          const replacementTerminalId = await createTerminal();
          const replacementTab = createTabFromTerminal(replacementTerminalId, []);
          setLayout({ tabs: [replacementTab], active_tab_id: replacementTab.tab_id });
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
          ? remainingTabs[Math.max(0, nextLayout.tabs.findIndex((t) => t.tab_id === tabId) - 1)]
              ?.tab_id ?? remainingTabs[0]!.tab_id
          : nextLayout.active_tab_id;

      setLayout({ tabs: remainingTabs, active_tab_id: nextActiveId });
    },
    [createTerminal, deleteTerminal]
  );

  const closeActivePane = useCallback(async () => {
    const current = layoutRef.current;
    if (!current) {
      return;
    }

    const tab = current.tabs.find((candidate) => candidate.tab_id === current.active_tab_id);
    if (!tab) {
      return;
    }

    const pane = tab.panes.find((candidate) => candidate.pane_id === tab.active_pane_id);
    if (!pane) {
      return;
    }

    try {
      await deleteTerminal(pane.terminal_id);
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

    const remainingPanes = tab.panes.filter((candidate) => candidate.pane_id !== pane.pane_id);
    const activePaneId = remainingPanes[0]!.pane_id;

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
            split_mode: "none",
            panes: remainingPanes,
            active_pane_id: activePaneId,
          };
        }),
      };
    });
  }, [closeTabById, deleteTerminal]);

  const restartActivePane = useCallback(async () => {
    const current = layoutRef.current;
    if (!current) {
      return;
    }

    const tab = current.tabs.find((candidate) => candidate.tab_id === current.active_tab_id);
    if (!tab) {
      return;
    }

    const pane = tab.panes.find((candidate) => candidate.pane_id === tab.active_pane_id);
    if (!pane) {
      return;
    }

    try {
      const newTerminalId = await createTerminal();
      await deleteTerminal(pane.terminal_id);

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
              panes: candidateTab.panes.map((candidatePane) =>
                candidatePane.pane_id === pane.pane_id
                  ? { ...candidatePane, terminal_id: newTerminalId }
                  : candidatePane
              ),
            };
          }),
        };
      });
    } catch (error) {
      toast.error(
        `Failed restarting terminal pane: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }, [createTerminal, deleteTerminal]);

  useEffect(() => {
    let isCancelled = false;

    const initialize = async () => {
      setIsInitializingTerminals(true);
      try {
        const warmupResponse = await fetch(`${CODEX_LABS_API_PREFIX}/warmup`, {
          method: "POST",
        });
        if (!warmupResponse.ok) {
          throw new Error(await getFetchErrorMessage(warmupResponse));
        }

        const warmupPayload = (await warmupResponse.json()) as WarmupResponse;
        let terminalIds = await listTerminals();

        if (warmupPayload.terminal_id && !terminalIds.includes(warmupPayload.terminal_id)) {
          terminalIds = [...terminalIds, warmupPayload.terminal_id];
        }

        if (terminalIds.length === 0) {
          const terminalId = await createTerminal();
          terminalIds = [terminalId];
        }

        const savedLayout = loadPersistedLayout();
        const nextLayout = reconcileLayout(savedLayout, terminalIds);

        if (!isCancelled) {
          setLayout(nextLayout);
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
  }, [createTerminal, listTerminals]);

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
    return layout.tabs.find((tab) => tab.tab_id === layout.active_tab_id) ?? null;
  }, [layout]);

  const activePane = useMemo(() => {
    if (!activeTab) {
      return null;
    }
    return (
      activeTab.panes.find((pane) => pane.pane_id === activeTab.active_pane_id) ??
      activeTab.panes[0] ??
      null
    );
  }, [activeTab]);

  const activeTerminalId = activePane?.terminal_id ?? null;

  useEffect(() => {
    if (isInitializingTerminals || !activeTerminalId) {
      setActiveTerminalStatus(null);
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;

    const pollStatus = async () => {
      try {
        const response = await fetch(
          `${CODEX_LABS_API_PREFIX}/terminal/status?terminal_id=${encodeURIComponent(
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
  }, [activeTerminalId, isInitializingTerminals]);

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

  return (
    <div className="h-[100dvh] w-full p-3 md:p-4 bg-background-neutral-01">
      <div className="h-full w-full rounded-16 border border-border-01 bg-background-neutral-02 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between gap-2 p-2 border-b border-border-01 bg-background-neutral-01">
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
            <SvgTerminal className="w-4 h-4 stroke-text-03 shrink-0" />
            <Text mainUiAction className="truncate">
              Codex Labs
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
            <Button
              tertiary
              size="md"
              disabled={!activePane}
              leftIcon={SvgRefreshCw}
              onClick={() => void restartActivePane()}
            >
              Restart Pane
            </Button>
          </div>
        </div>

        <div
          ref={workspaceSplitRef}
          className={`relative min-h-0 flex-1 flex flex-col md:flex-row ${
            isResizingNavigator ? "cursor-col-resize select-none" : ""
          }`}
        >
          {isDesktopLayout ? (
            <div className="pointer-events-none absolute left-1 top-2 z-20 hidden md:flex">
              <Button
                tertiary
                size="md"
                className="pointer-events-auto"
                title={
                  isNavigatorCollapsed
                    ? "Expand file navigator"
                    : "Collapse file navigator"
                }
                onClick={() => setIsNavigatorCollapsed((previousState) => !previousState)}
              >
                {isNavigatorCollapsed ? (
                  <SvgChevronRight className="h-4 w-4 stroke-text-03" />
                ) : (
                  <SvgChevronLeft className="h-4 w-4 stroke-text-03" />
                )}
              </Button>
            </div>
          ) : null}

          {isNavigatorVisible ? (
            <aside
              className="flex min-h-0 w-full md:w-auto md:shrink-0 flex-col border-b border-border-01 md:border-b-0"
              style={isDesktopLayout ? { width: `${navigatorWidth}px` } : undefined}
            >
            <div className="p-2 border-b border-border-01 bg-background-neutral-01">
              <div className="flex items-center justify-between gap-2 md:pl-10">
                <div className="min-w-0 flex items-center gap-1.5">
                  <SvgFolder className="w-4 h-4 stroke-text-03 shrink-0" />
                  <Text mainUiAction>File Navigator</Text>
                </div>
                <Text
                  className="truncate max-w-[10rem] md:max-w-[14rem]"
                  text03
                  title={pathLabel}
                >
                  {pathLabel}
                </Text>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <Button
                  tertiary
                  size="md"
                  leftIcon={SvgChevronLeft}
                  disabled={!currentPath}
                  onClick={() => void navigateUp()}
                >
                  Up
                </Button>
                <div className="flex items-center gap-1.5">
                  <Button
                    tertiary
                    size="md"
                    leftIcon={SvgFolderPlus}
                    onClick={() => void createFolder()}
                  >
                    Folder
                  </Button>
                  <Button tertiary size="md" onClick={triggerUpload}>
                    Upload
                  </Button>
                  <Button
                    tertiary
                    size="md"
                    leftIcon={SvgRefreshCw}
                    onClick={() => void refreshDirectory()}
                  >
                    Refresh
                  </Button>
                </div>
              </div>
            </div>

            <input
              ref={fileUploadInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={uploadFile}
            />

            <div className="min-h-0 flex-1 overflow-auto p-1.5">
              <CodexLabsFileTree
                entriesByPath={treeEntries}
                expandedPaths={expandedPaths}
                loadingPaths={loadingPaths}
                selectedPath={selectedPath}
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
                canPreviewEntry={isPreviewable}
              />
            </div>
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
          ) : (
            <div className="hidden md:block w-2 shrink-0" />
          )}

          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center justify-between p-2 border-b border-border-01 bg-background-neutral-01 gap-2">
              <div className="min-w-0">
                <Text mainUiAction className="truncate">
                  {activeTab?.title ?? "Terminals"}
                </Text>
                {activeTab ? (
                  activeTab.split_mode !== "none" ? (
                    <Text text03 className="truncate text-xs">
                      {`${getSplitModeLabel(activeTab.split_mode)}${
                        activeTab.panes.length > 1 && activePane
                          ? ` · Pane ${
                              activeTab.panes.findIndex(
                                (pane) => pane.pane_id === activePane.pane_id
                              ) + 1
                            } active`
                          : ""
                      }`}
                    </Text>
                  ) : null
                ) : (
                  <Text text03 className="truncate text-xs">
                    No active terminal
                  </Text>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  tertiary
                  size="md"
                  disabled={!activePane}
                  onClick={() => void closeActivePane()}
                >
                  Close Pane
                </Button>
                <Button
                  tertiary
                  size="md"
                  disabled={!activeTab}
                  onClick={() => activeTab && void closeTabById(activeTab.tab_id)}
                >
                  Close Terminal
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex flex-1">
              <div
                ref={previewWorkspaceRef}
                className="relative min-h-0 flex-1 overflow-hidden bg-black"
              >
                {isInitializingTerminals ? (
                  <div className="h-full w-full flex items-center justify-center p-3">
                    <Text text03>Initializing terminals...</Text>
                  </div>
                ) : !layout || layout.tabs.length === 0 ? (
                  <div className="h-full w-full flex items-center justify-center p-3">
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
                                  isActivePane
                                    ? "ring-1 ring-border-04"
                                    : "ring-0"
                                }`}
                                onMouseDown={() => setActivePane(tab.tab_id, pane.pane_id)}
                              >
                                <TerminalPane
                                  terminalId={pane.terminal_id}
                                  isActive={isActivePane}
                                  onFocus={() => setActivePane(tab.tab_id, pane.pane_id)}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })
                )}

                <CodexLabsPreviewWindows
                  windows={previewWindows}
                  workspaceBounds={workspaceBounds}
                  onCloseWindow={closePreviewWindow}
                  onFocusWindow={focusPreviewWindow}
                  onTextFileSaved={() => {
                    void refreshDirectory();
                  }}
                  onUpdateWindow={updatePreviewWindow}
                />
              </div>

              <aside className="hidden w-[248px] shrink-0 border-l border-border-01 bg-background-neutral-01 md:flex md:flex-col">
                <div className="flex items-center justify-between border-b border-border-01 px-3 py-2">
                  <Text mainUiAction>Terminal Navigator</Text>
                  <Text text03 className="text-xs">
                    {layout?.tabs.length ?? 0} open
                  </Text>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-2">
                  <div className="flex flex-col gap-2">
                    {(layout?.tabs ?? []).map((tab, tabIndex) => {
                      const isActiveTab = layout?.active_tab_id === tab.tab_id;
                      const isSplitGroup = tab.panes.length > 1;

                      return (
                        <div
                          key={tab.tab_id}
                          className={`rounded-12 border ${
                            isActiveTab
                              ? "border-border-04 bg-background-tint-03/60"
                              : "border-border-01 bg-background-neutral-02"
                          }`}
                        >
                          {isSplitGroup ? (
                            <>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 border-b border-border-01 px-3 py-2 text-left hover:bg-background-neutral-01/70"
                                onClick={() => setActiveTab(tab.tab_id)}
                              >
                                <SvgTerminal className="h-4 w-4 shrink-0 stroke-text-03" />
                                <div className="min-w-0 flex-1">
                                  <Text className="truncate">{tab.title}</Text>
                                  <Text text03 className="truncate text-xs">
                                    {getSplitModeLabel(tab.split_mode)} · {tab.panes.length} terminals
                                  </Text>
                                </div>
                              </button>
                              <div className="flex flex-col gap-1 p-1.5">
                                {tab.panes.map((pane, paneIndex) => {
                                  const isActivePane =
                                    isActiveTab && tab.active_pane_id === pane.pane_id;

                                  return (
                                    <button
                                      key={pane.pane_id}
                                      type="button"
                                      className={`flex w-full items-center gap-2 rounded-10 px-2 py-1.5 text-left ${
                                        isActivePane
                                          ? "bg-background-neutral-00 ring-1 ring-border-04"
                                          : "hover:bg-background-neutral-01"
                                      }`}
                                      onClick={() => setActivePane(tab.tab_id, pane.pane_id)}
                                    >
                                      <span
                                        className={`h-2 w-2 shrink-0 rounded-full ${
                                          isActivePane ? "bg-green-500" : "bg-border-03"
                                        }`}
                                      />
                                      <div className="min-w-0 flex-1">
                                        <Text className="truncate">
                                          Pane {paneIndex + 1}
                                        </Text>
                                        <Text text03 className="truncate text-xs">
                                          Terminal {tabIndex + 1}.{paneIndex + 1}
                                        </Text>
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            </>
                          ) : (
                            <button
                              type="button"
                              className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
                                isActiveTab
                                  ? "bg-background-neutral-00"
                                  : "hover:bg-background-neutral-01"
                              }`}
                              onClick={() =>
                                setActivePane(tab.tab_id, tab.panes[0]!.pane_id)
                              }
                            >
                              <SvgTerminal className="h-4 w-4 shrink-0 stroke-text-03" />
                              <Text className="min-w-0 flex-1 truncate">
                                {tab.title}
                              </Text>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </aside>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
