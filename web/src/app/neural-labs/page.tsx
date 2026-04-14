"use client";

import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Content } from "@opal/layouts";
import {
  SvgChevronLeft,
  SvgChevronRight,
  SvgFolder,
  SvgFolderPlus,
  SvgRefreshCw,
  SvgTerminal,
  SvgX,
} from "@opal/icons";
import Text from "@/refresh-components/texts/Text";

interface WarmupResponse {
  home_dir: string;
  terminal_id: string | null;
}

interface TerminalDescriptor {
  terminal_id: string;
}

interface TerminalListResponse {
  terminals: TerminalDescriptor[];
}

interface TerminalWebSocketTokenResponse {
  token: string;
  ws_path: string;
}

interface FileEntry {
  name: string;
  path: string;
  is_directory: boolean;
  mime_type?: string | null;
  size?: number | null;
  modified_at?: string | null;
}

interface DirectoryResponse {
  path: string;
  entries: FileEntry[];
}

type PreviewKind = "text" | "image" | "pdf" | "html" | null;
type SplitMode = "none" | "vertical" | "horizontal";
type FocusedPane = "primary" | "secondary";

const API_PREFIX = "/api/neural-labs";

function getParentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function formatTerminalLabel(index: number): string {
  return `Terminal ${index + 1}`;
}

function formatSize(size?: number | null): string {
  if (size == null) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function contentUrl(path: string, download = false): string {
  const params = new URLSearchParams({ path });
  if (download) {
    params.set("download", "true");
  }
  return `${API_PREFIX}/files/content?${params.toString()}`;
}

function getPreviewKind(entry: FileEntry): PreviewKind {
  const mime = entry.mime_type?.toLowerCase() ?? "";
  const name = entry.name.toLowerCase();
  if (mime.startsWith("image/")) {
    return "image";
  }
  if (mime.includes("pdf") || name.endsWith(".pdf")) {
    return "pdf";
  }
  if (mime.includes("html") || name.endsWith(".html") || name.endsWith(".htm")) {
    return "html";
  }
  if (
    mime.startsWith("text/") ||
    mime.includes("json") ||
    name.endsWith(".md") ||
    name.endsWith(".txt") ||
    name.endsWith(".py") ||
    name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".js") ||
    name.endsWith(".jsx") ||
    name.endsWith(".json") ||
    name.endsWith(".css") ||
    name.endsWith(".csv") ||
    name.endsWith(".yml") ||
    name.endsWith(".yaml")
  ) {
    return "text";
  }
  return null;
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { detail?: string };
    if (payload.detail) {
      return payload.detail;
    }
  } catch {
    // Ignore JSON parsing failures.
  }
  return response.statusText || `Request failed (${response.status})`;
}

function TerminalPane({
  terminalId,
  resolvedTheme,
}: {
  terminalId: string | null;
  resolvedTheme: string | undefined;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }

    terminal.options.theme = {
      background: resolvedTheme === "light" ? "#f7f7f5" : "#111317",
      foreground: resolvedTheme === "light" ? "#171717" : "#f3f4f6",
      cursor: resolvedTheme === "light" ? "#171717" : "#f9fafb",
      selectionBackground: resolvedTheme === "light" ? "#d4d4d4" : "#374151",
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !terminalId) {
      return;
    }

    host.innerHTML = "";
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
      scrollback: 5000,
      theme: {
        background: resolvedTheme === "light" ? "#f7f7f5" : "#111317",
        foreground: resolvedTheme === "light" ? "#171717" : "#f3f4f6",
        cursor: resolvedTheme === "light" ? "#171717" : "#f9fafb",
        selectionBackground: resolvedTheme === "light" ? "#d4d4d4" : "#374151",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const sendInput = async (data: string) => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(data);
        return;
      }

      await fetch(`${API_PREFIX}/terminal/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminal_id: terminalId, data }),
      });
    };

    const resizeTerminal = async () => {
      fitAddon.fit();
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

      await fetch(`${API_PREFIX}/terminal/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          terminal_id: terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        }),
      });
    };

    const connectSocket = async () => {
      const tokenResponse = await fetch(`${API_PREFIX}/terminal/ws-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ terminal_id: terminalId }),
      });
      if (!tokenResponse.ok) {
        terminal.writeln(`\r\n[terminal stream failed: ${await readError(tokenResponse)}]`);
        return;
      }

      const tokenPayload = (await tokenResponse.json()) as TerminalWebSocketTokenResponse;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const wsUrl = `${scheme}://${window.location.host}${tokenPayload.ws_path}`;
      const socket = new WebSocket(wsUrl);
      socketRef.current = socket;

      socket.onmessage = (event) => {
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
          // Ignore malformed events.
        }
      };

      socket.onerror = () => {
        terminal.writeln("\r\n[terminal stream error]");
      };

      socket.onclose = () => {
        terminal.writeln("\r\n[terminal stream disconnected]");
      };
    };

    const dataSubscription = terminal.onData((data) => {
      void sendInput(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      void resizeTerminal();
    });
    resizeObserver.observe(host);
    void connectSocket();
    void resizeTerminal();

    return () => {
      dataSubscription.dispose();
      resizeObserver.disconnect();
      socketRef.current?.close();
      socketRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [resolvedTheme, terminalId]);

  return (
    <div className="h-full min-h-[260px] rounded-12 border border-border-02 bg-[#070d18]">
      <div ref={hostRef} className="h-full min-h-[260px] px-2 py-2" />
    </div>
  );
}

export default function NeuralLabsPage() {
  const { resolvedTheme } = useTheme();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [homeDir, setHomeDir] = useState("");
  const [terminalIds, setTerminalIds] = useState<string[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [secondaryTerminalId, setSecondaryTerminalId] = useState<string | null>(null);
  const [splitMode, setSplitMode] = useState<SplitMode>("none");
  const [focusedPane, setFocusedPane] = useState<FocusedPane>("primary");
  const [listing, setListing] = useState<DirectoryResponse | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<FileEntry | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activePreviewKind = selectedEntry ? getPreviewKind(selectedEntry) : null;

  async function loadDirectory(path: string) {
    const response = await fetch(`${API_PREFIX}/files?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const data = (await response.json()) as DirectoryResponse;
    setListing(data);
    setCurrentPath(data.path);
  }

  async function loadTerminals(preferredTerminalId?: string | null) {
    const response = await fetch(`${API_PREFIX}/terminals`);
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    const data = (await response.json()) as TerminalListResponse;
    const nextIds = data.terminals.map((terminal) => terminal.terminal_id);
    setTerminalIds(nextIds);
    if (preferredTerminalId && nextIds.includes(preferredTerminalId)) {
      setActiveTerminalId(preferredTerminalId);
    } else {
      setActiveTerminalId(nextIds[0] ?? null);
    }
    if (!nextIds.length) {
      setSecondaryTerminalId(null);
      setSplitMode("none");
    }
    if (secondaryTerminalId && !nextIds.includes(secondaryTerminalId)) {
      setSecondaryTerminalId(null);
      setSplitMode("none");
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      try {
        setIsLoading(true);
        setError(null);

        const warmupResponse = await fetch(`${API_PREFIX}/warmup`, { method: "POST" });
        if (!warmupResponse.ok) {
          throw new Error(await readError(warmupResponse));
        }
        const warmup = (await warmupResponse.json()) as WarmupResponse;
        if (cancelled) {
          return;
        }

        setHomeDir(warmup.home_dir);
        await Promise.all([
          loadDirectory(""),
          loadTerminals(warmup.terminal_id),
        ]);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load Neural Labs");
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void initialize();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runMutation(action: () => Promise<void>) {
    try {
      setIsMutating(true);
      setError(null);
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setIsMutating(false);
    }
  }

  async function handleOpenEntry(entry: FileEntry) {
    setSelectedEntry(entry);
    if (entry.is_directory) {
      await loadDirectory(entry.path);
      return;
    }
  }

  async function handlePreview(entry: FileEntry) {
    setSelectedEntry(entry);
    const kind = getPreviewKind(entry);
    if (kind === "text") {
      const response = await fetch(contentUrl(entry.path));
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const text = await response.text();
      setPreviewText(text);
    } else {
      setPreviewText(null);
    }
    setPreviewOpen(true);
  }

  async function handleCreateFolder() {
    const name = window.prompt("Folder name");
    if (!name) {
      return;
    }
    await runMutation(async () => {
      const response = await fetch(`${API_PREFIX}/directories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_path: currentPath, name }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      await loadDirectory(currentPath);
    });
  }

  async function handleUpload(files: FileList | null) {
    if (!files?.length) {
      return;
    }
    await runMutation(async () => {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        formData.append("_path", currentPath);
        const response = await fetch(`${API_PREFIX}/files/upload`, {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          throw new Error(await readError(response));
        }
      }
      await loadDirectory(currentPath);
    });
  }

  async function handleNewTerminal() {
    await runMutation(async () => {
      const response = await fetch(`${API_PREFIX}/terminals`, { method: "POST" });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const data = (await response.json()) as TerminalDescriptor;
      await loadTerminals(data.terminal_id);
    });
  }

  async function handleCloseTerminal() {
    if (!activeTerminalId) {
      return;
    }
    await runMutation(async () => {
      await fetch(`${API_PREFIX}/terminals/${activeTerminalId}`, { method: "DELETE" });
      await loadTerminals(null);
    });
  }

  async function handleRestartTerminal() {
    if (activeTerminalId) {
      await fetch(`${API_PREFIX}/terminals/${activeTerminalId}`, { method: "DELETE" });
    }
    await handleNewTerminal();
  }

  async function handleSetSplit(nextSplitMode: SplitMode) {
    if (nextSplitMode === "none") {
      setSplitMode("none");
      setSecondaryTerminalId(null);
      return;
    }

    await runMutation(async () => {
      let primaryId = activeTerminalId;
      if (!primaryId) {
        const createResponse = await fetch(`${API_PREFIX}/terminals`, { method: "POST" });
        if (!createResponse.ok) {
          throw new Error(await readError(createResponse));
        }
        const created = (await createResponse.json()) as TerminalDescriptor;
        primaryId = created.terminal_id;
      }

      let nextSecondaryId =
        terminalIds.find((terminalId) => terminalId !== primaryId) ?? secondaryTerminalId;

      if (!nextSecondaryId) {
        const createResponse = await fetch(`${API_PREFIX}/terminals`, { method: "POST" });
        if (!createResponse.ok) {
          throw new Error(await readError(createResponse));
        }
        const created = (await createResponse.json()) as TerminalDescriptor;
        nextSecondaryId = created.terminal_id;
      }

      await loadTerminals(primaryId);
      setSecondaryTerminalId(nextSecondaryId);
      setSplitMode(nextSplitMode);
      setFocusedPane("primary");
    });
  }

  async function handleClosePane() {
    if (splitMode === "none") {
      await handleCloseTerminal();
      return;
    }

    if (focusedPane === "secondary") {
      setSplitMode("none");
      setSecondaryTerminalId(null);
      return;
    }

    if (secondaryTerminalId) {
      setActiveTerminalId(secondaryTerminalId);
    }
    setSplitMode("none");
    setSecondaryTerminalId(null);
    setFocusedPane("primary");
  }

  const breadcrumbs = useMemo(() => {
    const parts = currentPath.split("/").filter(Boolean);
    return parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join("/"),
    }));
  }, [currentPath]);

  const hasSplit = splitMode !== "none" && Boolean(secondaryTerminalId);
  const primaryTerminalLabel = activeTerminalId
    ? formatTerminalLabel(terminalIds.findIndex((id) => id === activeTerminalId))
    : "Terminal";
  const secondaryTerminalLabel = secondaryTerminalId
    ? formatTerminalLabel(terminalIds.findIndex((id) => id === secondaryTerminalId))
    : "Terminal 2";

  return (
    <div className="mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-[1500px] flex-col gap-4 px-4 py-6 md:px-6">
      <div className="flex items-center gap-3 text-sm text-text-03">
        <a href="/app" className="inline-flex items-center gap-2 hover:text-text-01">
          <SvgChevronLeft className="h-4 w-4" />
          Back to Main Chat
        </a>
        <span>|</span>
        <span className="font-medium text-text-01">Neural Labs</span>
      </div>

      <div className="rounded-16 border border-border-02 bg-background-100 shadow-[0_8px_32px_rgba(0,0,0,0.08)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-02 px-4 py-3">
          <Content
            sizePreset="main-ui"
            variant="section"
            title="Neural Labs"
            description={homeDir ? `Home: ${homeDir}` : "Preparing workspace"}
          />

          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-600 dark:text-emerald-400">
              Environment: Ready
            </div>
            <button
              className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
              onClick={() => void handleNewTerminal()}
              disabled={isLoading || isMutating}
            >
              New Terminal
            </button>
            <button
              className={`rounded-08 border px-3 py-1.5 text-sm disabled:opacity-50 ${
                splitMode === "vertical"
                  ? "border-border-04 bg-background-tint-02"
                  : "border-border-01 hover:bg-background-tint-00"
              }`}
              onClick={() => void handleSetSplit("vertical")}
              disabled={isLoading || isMutating}
            >
              Split Vertical
            </button>
            <button
              className={`rounded-08 border px-3 py-1.5 text-sm disabled:opacity-50 ${
                splitMode === "horizontal"
                  ? "border-border-04 bg-background-tint-02"
                  : "border-border-01 hover:bg-background-tint-00"
              }`}
              onClick={() => void handleSetSplit("horizontal")}
              disabled={isLoading || isMutating}
            >
              Split Horizontal
            </button>
            <button
              className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
              onClick={() => void handleClosePane()}
              disabled={!activeTerminalId || isMutating}
            >
              Close Pane
            </button>
            <button
              className="rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00 disabled:opacity-50"
              onClick={() => void handleRestartTerminal()}
              disabled={!activeTerminalId || isMutating}
            >
              Restart Pane
            </button>
          </div>
        </div>

        {error ? (
          <div className="border-b border-border-02 bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
            {error}
          </div>
        ) : null}

        <div className="grid min-h-[78vh] grid-cols-1 gap-0 xl:grid-cols-[360px_1fr_220px]">
          <div className="border-b border-border-02 xl:border-b-0 xl:border-r">
            <div className="flex items-center justify-between border-b border-border-02 px-4 py-3">
              <div className="flex items-center gap-2">
                <SvgFolder className="h-4 w-4" />
                <Text as="p" mainUiBody>
                  File Navigator
                </Text>
              </div>
              <button
                className="rounded-08 p-1 hover:bg-background-tint-00"
                onClick={() => void loadDirectory(currentPath)}
              >
                <SvgRefreshCw className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-border-02 px-4 py-2">
              <button
                className="rounded-08 p-1 hover:bg-background-tint-00 disabled:opacity-50"
                disabled={!currentPath}
                onClick={() => void loadDirectory(getParentPath(currentPath))}
              >
                <SvgChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm text-text-03">Up</span>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-border-02 px-4 py-3">
              <button
                className="inline-flex items-center gap-2 rounded-08 border border-border-01 px-2.5 py-1.5 text-sm hover:bg-background-tint-00"
                onClick={() => void handleCreateFolder()}
              >
                <SvgFolderPlus className="h-4 w-4" />
                Folder
              </button>
              <button
                className="rounded-08 border border-border-01 px-2.5 py-1.5 text-sm hover:bg-background-tint-00"
                onClick={() => fileInputRef.current?.click()}
              >
                Upload
              </button>
              <button
                className="rounded-08 border border-border-01 px-2.5 py-1.5 text-sm hover:bg-background-tint-00"
                onClick={() => void loadDirectory(currentPath)}
              >
                Refresh
              </button>
              <input
                ref={fileInputRef}
                className="hidden"
                type="file"
                multiple
                onChange={(event) => void handleUpload(event.target.files)}
              />
            </div>

            <div className="border-b border-border-02 bg-background-200 px-4 py-3 text-sm text-text-03">
              Drop files here to upload to home (`~`)
            </div>

            <div className="max-h-[calc(78vh-180px)] overflow-auto px-2 py-2">
              <div className="mb-3 flex flex-wrap items-center gap-2 px-2 text-xs text-text-03">
                <button
                  className="rounded-08 border border-border-01 px-2 py-1 hover:bg-background-tint-00"
                  onClick={() => void loadDirectory("")}
                >
                  root
                </button>
                {breadcrumbs.map((crumb) => (
                  <button
                    key={crumb.path}
                    className="rounded-08 border border-border-01 px-2 py-1 hover:bg-background-tint-00"
                    onClick={() => void loadDirectory(crumb.path)}
                  >
                    {crumb.label}
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-1">
                {listing?.entries?.map((entry) => {
                  const previewKind = getPreviewKind(entry);
                  return (
                    <div
                      key={entry.path}
                      className={`flex items-center justify-between rounded-08 px-3 py-2 ${
                        selectedEntry?.path === entry.path
                          ? "bg-background-tint-02"
                          : "hover:bg-background-tint-00"
                      }`}
                    >
                      <button
                        className="min-w-0 flex-1 text-left"
                        onClick={() => void handleOpenEntry(entry)}
                      >
                        <Text as="p" mainUiBody className="truncate">
                          {entry.is_directory ? "▸" : "•"} {entry.name}
                        </Text>
                        {!entry.is_directory ? (
                          <Text as="p" mainUiBody text03 className="truncate">
                            {formatSize(entry.size)}
                          </Text>
                        ) : null}
                      </button>

                      {!entry.is_directory && previewKind ? (
                        <button
                          className="rounded-full border border-border-01 px-2 py-0.5 text-xs hover:bg-background-tint-00"
                          onClick={() => void handlePreview(entry)}
                        >
                          Preview
                        </button>
                      ) : null}
                    </div>
                  );
                })}

                {!listing?.entries?.length && !isLoading ? (
                  <Text as="p" mainUiBody text03 className="px-2 py-4">
                    This folder is empty.
                  </Text>
                ) : null}
              </div>
            </div>
          </div>

          <div className="border-b border-border-02 px-2 py-2 xl:border-b-0 xl:border-r">
            <div className="mb-2 flex items-center justify-between px-2 py-1">
              <Text as="p" mainUiBody>
                {focusedPane === "secondary" && hasSplit
                  ? secondaryTerminalLabel
                  : primaryTerminalLabel}
              </Text>
              <div className="flex items-center gap-3 text-sm">
                <button
                  className="hover:text-text-01 disabled:opacity-50"
                  onClick={() => void handleClosePane()}
                  disabled={!activeTerminalId}
                >
                  Close Pane
                </button>
              </div>
            </div>
            {hasSplit ? (
              <div
                className={`grid gap-2 ${
                  splitMode === "vertical" ? "h-[70vh] grid-cols-2" : "h-[70vh] grid-rows-2"
                }`}
              >
                <div
                  className={`rounded-12 border ${
                    focusedPane === "primary" ? "border-border-04" : "border-transparent"
                  } p-1`}
                  onMouseDown={() => setFocusedPane("primary")}
                >
                  <div className="mb-1 px-2 text-xs text-text-03">{primaryTerminalLabel}</div>
                  <TerminalPane terminalId={activeTerminalId} resolvedTheme={resolvedTheme} />
                </div>
                <div
                  className={`rounded-12 border ${
                    focusedPane === "secondary" ? "border-border-04" : "border-transparent"
                  } p-1`}
                  onMouseDown={() => setFocusedPane("secondary")}
                >
                  <div className="mb-1 px-2 text-xs text-text-03">{secondaryTerminalLabel}</div>
                  <TerminalPane
                    terminalId={secondaryTerminalId}
                    resolvedTheme={resolvedTheme}
                  />
                </div>
              </div>
            ) : (
              <TerminalPane terminalId={activeTerminalId} resolvedTheme={resolvedTheme} />
            )}
          </div>

          <div>
            <div className="flex items-center justify-between border-b border-border-02 px-4 py-3">
              <div className="flex items-center gap-2">
                <SvgTerminal className="h-4 w-4" />
                <Text as="p" mainUiBody>
                  Terminal Navigator
                </Text>
              </div>
              <span className="text-sm text-text-03">
                {terminalIds.length} open
              </span>
            </div>

            <div className="p-3">
              <div className="flex flex-col gap-2">
                {terminalIds.map((terminalId, index) => (
                  <button
                    key={terminalId}
                    className={`rounded-08 border px-3 py-2 text-left ${
                      terminalId === activeTerminalId
                        ? "border-border-04 bg-background-tint-02"
                        : "border-border-02 hover:bg-background-tint-00"
                    }`}
                    onClick={() => {
                      if (hasSplit && focusedPane === "secondary") {
                        setSecondaryTerminalId(terminalId);
                        return;
                      }
                      setActiveTerminalId(terminalId);
                    }}
                  >
                    <Text as="p" mainUiBody>
                      {formatTerminalLabel(index)}
                    </Text>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {previewOpen && selectedEntry ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
          <div className="max-h-[85vh] w-full max-w-5xl overflow-hidden rounded-16 border border-border-02 bg-background shadow-2xl">
            <div className="flex items-center justify-between border-b border-border-02 px-4 py-3">
              <Text as="p" mainUiBody>
                {selectedEntry.name}
              </Text>
              <button
                className="rounded-08 p-1 hover:bg-background-tint-00"
                onClick={() => setPreviewOpen(false)}
              >
                <SvgX className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[75vh] overflow-auto p-4">
              {activePreviewKind === "text" ? (
                <pre className="overflow-auto rounded-08 bg-background-200 p-4 text-sm">
                  {previewText}
                </pre>
              ) : null}
              {activePreviewKind === "image" ? (
                <img
                  alt={selectedEntry.name}
                  className="max-h-[70vh] w-full object-contain"
                  src={contentUrl(selectedEntry.path)}
                />
              ) : null}
              {activePreviewKind === "pdf" || activePreviewKind === "html" ? (
                <iframe
                  className="h-[70vh] w-full rounded-08 border border-border-02"
                  src={contentUrl(selectedEntry.path)}
                  title={selectedEntry.name}
                />
              ) : null}
              {!activePreviewKind ? (
                <a
                  className="inline-flex rounded-08 border border-border-01 px-3 py-1.5 text-sm hover:bg-background-tint-00"
                  href={contentUrl(selectedEntry.path, true)}
                >
                  Download file
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
