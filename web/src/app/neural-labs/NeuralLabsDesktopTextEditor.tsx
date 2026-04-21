"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTheme } from "next-themes";
import CommandMenu from "@/refresh-components/commandmenu/CommandMenu";
import Text from "@/refresh-components/texts/Text";
import {
  getCodeLanguage,
  getDataLanguage,
  getLanguageByMime,
  isMarkdownFile,
} from "@/lib/languages";
import type {
  DesktopEditorTabState,
  DesktopEditorWindowState,
} from "@/app/neural-labs/types";
import {
  SvgFileText,
  SvgFolderOpen,
  SvgPlus,
  SvgRefreshCw,
  SvgSearch,
  SvgSidebar,
  SvgX,
} from "@opal/icons";

interface NeuralLabsDesktopTextEditorProps {
  windowState: DesktopEditorWindowState;
  currentDirectory: string;
  onToggleSidebar: () => void;
  onCreateScratchTab: () => void;
  onSetActiveTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onChangeTabContent: (tabId: string, content: string) => void;
  onSaveTab: (tabId: string) => Promise<void> | void;
  onSaveTabAs: (tabId: string, targetPath: string) => Promise<void> | void;
  onReloadTab: (tabId: string) => Promise<void> | void;
}

function getEditorLanguage(tab: DesktopEditorTabState | null): string {
  if (!tab) {
    return "plaintext";
  }

  if (isMarkdownFile(tab.name)) {
    return "markdown";
  }

  return (
    getCodeLanguage(tab.name) ??
    getDataLanguage(tab.name) ??
    (tab.mime_type ? getLanguageByMime(tab.mime_type) : null) ??
    "plaintext"
  );
}

function isTabDirty(tab: DesktopEditorTabState): boolean {
  return tab.content !== tab.saved_content;
}

function formatPath(tab: DesktopEditorTabState | null): string {
  if (!tab?.path) {
    return "Unsaved scratch file";
  }
  return `~/${tab.path}`;
}

export default function NeuralLabsDesktopTextEditor({
  windowState,
  currentDirectory,
  onToggleSidebar,
  onCreateScratchTab,
  onSetActiveTab,
  onCloseTab,
  onChangeTabContent,
  onSaveTab,
  onSaveTabAs,
  onReloadTab,
}: NeuralLabsDesktopTextEditorProps) {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<Parameters<NonNullable<OnMount>>[0] | null>(null);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [isCommandMenuOpen, setIsCommandMenuOpen] = useState(false);
  const [isSaveAsOpen, setIsSaveAsOpen] = useState(false);
  const [saveAsValue, setSaveAsValue] = useState("");
  const [saveAsError, setSaveAsError] = useState<string | null>(null);

  const activeTab =
    windowState.tabs.find((tab) => tab.tab_id === windowState.active_tab_id) ??
    windowState.tabs[0] ??
    null;
  const activeLanguage = getEditorLanguage(activeTab);
  const isDarkMode = resolvedTheme === "dark";

  const shellClassName = isDarkMode
    ? "bg-[linear-gradient(180deg,#09111d,#0c1422)] text-white"
    : "bg-[linear-gradient(180deg,#f7faff,#eef3fa)] text-slate-900";
  const elevatedSurfaceClassName = isDarkMode
    ? "border-white/10 bg-white/[0.05]"
    : "border-slate-200/80 bg-white/84";
  const tabRailClassName = isDarkMode
    ? "border-white/10 bg-[#0d1524]/92"
    : "border-slate-200/80 bg-slate-100/85";
  const editorCanvasClassName = isDarkMode ? "bg-[#0a111d]" : "bg-white";
  const footerClassName = isDarkMode
    ? "border-white/10 bg-white/[0.06] text-white/45"
    : "border-slate-200/80 bg-white/82 text-slate-500";
  const modalShellClassName = isDarkMode
    ? "border-white/10 bg-[#101a2d]"
    : "border-slate-200/80 bg-white";

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    if (!isSaveAsOpen) {
      return;
    }

    setSaveAsValue(
      activeTab.path ??
        (currentDirectory ? `${currentDirectory}/untitled.txt` : "untitled.txt")
    );
    setSaveAsError(null);
  }, [activeTab, currentDirectory, isSaveAsOpen]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    window.requestAnimationFrame(() => {
      editor.focus();
    });
  }, [activeTab?.tab_id]);

  const openSaveAs = () => {
    setIsSaveAsOpen(true);
  };

  const handleSave = async () => {
    if (!activeTab) {
      return;
    }

    if (!activeTab.path) {
      openSaveAs();
      return;
    }

    await onSaveTab(activeTab.tab_id);
  };

  const handleReload = async () => {
    if (!activeTab || !activeTab.path) {
      return;
    }

    if (isTabDirty(activeTab)) {
      const shouldReload = window.confirm(
        `Discard unsaved changes in ${activeTab.name} and reload from disk?`
      );
      if (!shouldReload) {
        return;
      }
    }

    await onReloadTab(activeTab.tab_id);
  };

  const handleCloseTab = (tab: DesktopEditorTabState) => {
    if (isTabDirty(tab)) {
      const shouldClose = window.confirm(
        `Close ${tab.name} and discard unsaved changes?`
      );
      if (!shouldClose) {
        return;
      }
    }

    onCloseTab(tab.tab_id);
  };

  const submitSaveAs = async () => {
    if (!activeTab) {
      return;
    }

    const trimmedPath = saveAsValue.trim().replace(/^\/+/, "");
    if (!trimmedPath) {
      setSaveAsError("File name cannot be empty.");
      return;
    }

    try {
      await onSaveTabAs(activeTab.tab_id, trimmedPath);
      setIsSaveAsOpen(false);
      setSaveAsError(null);
    } catch (error) {
      setSaveAsError(
        error instanceof Error ? error.message : "Unable to save file."
      );
    }
  };

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void handleSave();
    });
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP,
      () => {
        setIsCommandMenuOpen(true);
      }
    );
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => {
      onToggleSidebar();
    });

    setCursorPosition({
      line: editor.getPosition()?.lineNumber ?? 1,
      column: editor.getPosition()?.column ?? 1,
    });

    editor.onDidChangeCursorPosition((event) => {
      setCursorPosition({
        line: event.position.lineNumber,
        column: event.position.column,
      });
    });
  };

  const commandActions = useMemo(
    () => [
      {
        value: "save",
        icon: SvgFileText,
        label: "Save",
        shortcut: "Ctrl+S",
        onSelect: () => void handleSave(),
      },
      {
        value: "save-as",
        icon: SvgFolderOpen,
        label: "Save As…",
        shortcut: "Ctrl+Shift+S",
        onSelect: () => openSaveAs(),
      },
      {
        value: "reload",
        icon: SvgRefreshCw,
        label: "Reload From Disk",
        onSelect: () => void handleReload(),
      },
      {
        value: "new-scratch",
        icon: SvgPlus,
        label: "New Scratch File",
        onSelect: () => onCreateScratchTab(),
      },
      {
        value: "toggle-sidebar",
        icon: SvgSidebar,
        label: windowState.is_sidebar_open ? "Hide Sidebar" : "Show Sidebar",
        shortcut: "Ctrl+B",
        onSelect: () => onToggleSidebar(),
      },
      {
        value: "close-tab",
        icon: SvgX,
        label: "Close Current Tab",
        onSelect: () => {
          if (activeTab) {
            handleCloseTab(activeTab);
          }
        },
      },
    ],
    [
      activeTab,
      onCreateScratchTab,
      onToggleSidebar,
      windowState.is_sidebar_open,
    ]
  );

  return (
    <div
      className={`relative flex h-full min-h-0 w-full overflow-hidden ${shellClassName}`}
    >
      {windowState.is_sidebar_open ? (
        <aside
          className={`flex w-64 shrink-0 flex-col border-r ${elevatedSurfaceClassName}`}
        >
          <div className="flex items-center justify-between border-b border-inherit px-3 py-2">
            <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-white/45">
              Open Files
            </Text>
            <button
              type="button"
              className="rounded-full p-1 text-slate-500 transition hover:bg-slate-200/70 hover:text-slate-900 dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white"
              onClick={onCreateScratchTab}
              aria-label="New scratch file"
            >
              <SvgPlus className="h-4 w-4 stroke-current" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {windowState.tabs.map((tab) => {
              const isActive = tab.tab_id === activeTab?.tab_id;
              const isDirty = isTabDirty(tab);
              return (
                <button
                  key={tab.tab_id}
                  type="button"
                  className={`group mb-1 flex w-full items-center gap-2 rounded-2xl px-3 py-2 text-left transition ${
                    isActive
                      ? "bg-slate-950 text-white shadow-sm dark:bg-white/14 dark:text-white"
                      : "text-slate-700 hover:bg-slate-200/80 dark:text-white/78 dark:hover:bg-white/8"
                  }`}
                  onClick={() => onSetActiveTab(tab.tab_id)}
                >
                  <SvgFileText
                    className={`h-4 w-4 shrink-0 stroke-current ${
                      isActive
                        ? "text-white"
                        : "text-slate-500 dark:text-white/45"
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Text
                        className={`truncate text-sm font-medium ${
                          isActive
                            ? "text-white"
                            : "text-slate-900 dark:text-white"
                        }`}
                      >
                        {tab.name}
                      </Text>
                      {isDirty ? (
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                      ) : null}
                    </div>
                    <Text
                      className={`truncate text-xs ${
                        isActive
                          ? "text-white/70"
                          : "text-slate-500 dark:text-white/45"
                      }`}
                    >
                      {tab.path ? `~/${tab.path}` : "Unsaved scratch"}
                    </Text>
                  </div>
                  <span
                    role="button"
                    tabIndex={0}
                    className={`rounded-full p-1 transition ${
                      isActive
                        ? "text-white/70 hover:bg-white/12 hover:text-white"
                        : "text-slate-500 opacity-0 group-hover:opacity-100 hover:bg-slate-300/80 hover:text-slate-900 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white"
                    }`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleCloseTab(tab);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        handleCloseTab(tab);
                      }
                    }}
                  >
                    <SvgX className="h-3.5 w-3.5 stroke-current" />
                  </span>
                </button>
              );
            })}
          </div>
        </aside>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className={`flex items-center justify-between gap-3 border-b px-3 py-1.5 ${elevatedSurfaceClassName}`}
        >
          <div className="min-w-0 flex items-center gap-2">
            <div className="min-w-0 rounded-full bg-slate-900/6 px-2.5 py-1 dark:bg-white/8">
              <Text className="truncate text-xs font-medium text-slate-900 dark:text-white">
                {activeTab ? formatPath(activeTab) : "No active document"}
              </Text>
            </div>
            <div className="rounded-full bg-slate-900/6 px-2.5 py-1 dark:bg-white/8">
              <Text className="whitespace-nowrap text-[11px] text-slate-500 dark:text-white/45">
                {activeTab?.is_loading
                  ? "Loading"
                  : activeTab?.is_saving
                    ? "Saving"
                    : activeTab
                      ? isTabDirty(activeTab)
                        ? "Unsaved"
                        : activeTab.last_saved_at
                          ? "Saved"
                          : activeTab.path
                            ? "Ready"
                            : "Scratch"
                      : "Idle"}
              </Text>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="rounded-full p-2 text-slate-500 transition hover:bg-slate-200/80 hover:text-slate-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
              onClick={onToggleSidebar}
              aria-label={
                windowState.is_sidebar_open ? "Hide sidebar" : "Show sidebar"
              }
            >
              <SvgSidebar className="h-4 w-4 stroke-current" />
            </button>
            <button
              type="button"
              className="rounded-full p-2 text-slate-500 transition hover:bg-slate-200/80 hover:text-slate-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
              onClick={onCreateScratchTab}
              aria-label="New scratch file"
            >
              <SvgPlus className="h-4 w-4 stroke-current" />
            </button>
            <button
              type="button"
              className="rounded-full p-2 text-slate-500 transition hover:bg-slate-200/80 hover:text-slate-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => void handleReload()}
              aria-label="Reload file"
              disabled={
                !activeTab?.path || activeTab.is_loading || activeTab.is_saving
              }
            >
              <SvgRefreshCw className="h-4 w-4 stroke-current" />
            </button>
            <button
              type="button"
              className="rounded-2xl border border-slate-300/80 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-200/80 dark:border-white/10 dark:text-white/80 dark:hover:bg-white/10"
              onClick={() => setIsCommandMenuOpen(true)}
            >
              Actions
            </button>
            <button
              type="button"
              className="rounded-2xl bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-45 dark:bg-white dark:text-slate-900 dark:hover:bg-white/85"
              onClick={() => void handleSave()}
              disabled={
                !activeTab || activeTab.is_loading || activeTab.is_saving
              }
            >
              Save
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={`flex items-center gap-1 overflow-x-auto border-b px-2 py-1.5 ${tabRailClassName}`}
          >
            {windowState.tabs.map((tab) => {
              const isActive = tab.tab_id === activeTab?.tab_id;
              const isDirty = isTabDirty(tab);
              return (
                <button
                  key={tab.tab_id}
                  type="button"
                  className={`group flex items-center gap-2 rounded-2xl border px-3 py-1.5 text-sm transition ${
                    isActive
                      ? "border-slate-300 bg-white text-slate-900 shadow-sm dark:border-white/10 dark:bg-white/12 dark:text-white"
                      : "border-transparent text-slate-600 hover:border-slate-300/80 hover:bg-white/80 hover:text-slate-900 dark:text-white/55 dark:hover:border-white/10 dark:hover:bg-white/8 dark:hover:text-white"
                  }`}
                  onClick={() => onSetActiveTab(tab.tab_id)}
                >
                  <SvgFileText className="h-4 w-4 shrink-0 stroke-current" />
                  <span className="max-w-[13rem] truncate">{tab.name}</span>
                  {isDirty ? (
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  ) : null}
                  <span
                    role="button"
                    tabIndex={0}
                    className={`rounded-full p-0.5 ${
                      isActive
                        ? "text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:text-white/60 dark:hover:bg-white/10 dark:hover:text-white"
                        : "text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-200 hover:text-slate-900 dark:text-white/35 dark:hover:bg-white/10 dark:hover:text-white"
                    }`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      handleCloseTab(tab);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        handleCloseTab(tab);
                      }
                    }}
                  >
                    <SvgX className="h-3 w-3 stroke-current" />
                  </span>
                </button>
              );
            })}
          </div>

          {activeTab?.error_message ? (
            <div className="border-b border-rose-300/60 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-500/10 dark:text-rose-200">
              {activeTab.error_message}
            </div>
          ) : null}

          <div className={`relative min-h-0 flex-1 ${editorCanvasClassName}`}>
            {activeTab ? (
              <Editor
                key={activeTab.tab_id}
                path={activeTab.path ?? activeTab.name}
                value={activeTab.content}
                language={activeLanguage}
                theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                onMount={handleEditorMount}
                onChange={(value) =>
                  onChangeTabContent(activeTab.tab_id, value ?? "")
                }
                loading={
                  <div className="flex h-full items-center justify-center">
                    <Text className="text-sm text-slate-500 dark:text-white/50">
                      Loading editor...
                    </Text>
                  </div>
                }
                options={{
                  automaticLayout: true,
                  fontSize: 14,
                  fontLigatures: true,
                  lineNumbers: "on",
                  minimap: { enabled: true },
                  roundedSelection: true,
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  tabSize: 2,
                  useShadowDOM: false,
                  wordWrap: "on",
                  padding: { top: 14, bottom: 14 },
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <button
                  type="button"
                  className="rounded-2xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:border-white/10 dark:bg-white/10 dark:text-white dark:hover:bg-white/14"
                  onClick={onCreateScratchTab}
                >
                  New Scratch File
                </button>
              </div>
            )}
          </div>

          <div
            className={`flex items-center justify-between gap-3 border-t px-3 py-1.5 text-xs ${footerClassName}`}
          >
            <div className="min-w-0 truncate">
              {activeTab
                ? `${activeLanguage} · ${formatPath(activeTab)}`
                : "No active document"}
            </div>
            <div className="shrink-0">
              Ln {cursorPosition.line}, Col {cursorPosition.column}
            </div>
          </div>
        </div>
      </div>

      {isSaveAsOpen ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/35 px-4 backdrop-blur-sm">
          <div
            className={`w-full max-w-lg rounded-[28px] border p-5 shadow-[0_28px_80px_rgba(15,23,42,0.28)] ${modalShellClassName}`}
          >
            <div className="mb-4">
              <Text className="text-base font-semibold text-slate-900 dark:text-white">
                Save File As
              </Text>
              <Text className="mt-1 text-sm text-slate-500 dark:text-white/50">
                Choose a workspace path for the current document.
              </Text>
            </div>
            <input
              autoFocus
              type="text"
              value={saveAsValue}
              onChange={(event) => {
                setSaveAsValue(event.target.value);
                if (saveAsError) {
                  setSaveAsError(null);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitSaveAs();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setIsSaveAsOpen(false);
                  setSaveAsError(null);
                }
              }}
              className="w-full rounded-2xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none ring-0 placeholder:text-slate-400 focus:border-slate-500 dark:border-white/10 dark:bg-white/6 dark:text-white dark:placeholder:text-white/30"
              placeholder="folder/filename.txt"
            />
            {saveAsError ? (
              <Text className="mt-2 text-sm text-rose-600 dark:text-rose-300">
                {saveAsError}
              </Text>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-2xl border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-white/10 dark:text-white/80 dark:hover:bg-white/10"
                onClick={() => {
                  setIsSaveAsOpen(false);
                  setSaveAsError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-2xl bg-slate-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-slate-700 dark:bg-white dark:text-slate-900 dark:hover:bg-white/85"
                onClick={() => void submitSaveAs()}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <CommandMenu open={isCommandMenuOpen} onOpenChange={setIsCommandMenuOpen}>
        <CommandMenu.Content>
          <CommandMenu.Header placeholder="Search editor actions..." />
          <CommandMenu.List emptyMessage="No editor actions found.">
            {commandActions.map((action) => (
              <CommandMenu.Action
                key={action.value}
                value={action.value}
                icon={action.icon}
                shortcut={action.shortcut}
                onSelect={() => action.onSelect()}
              >
                {action.label}
              </CommandMenu.Action>
            ))}
          </CommandMenu.List>
          <CommandMenu.Footer
            leftActions={
              <>
                <CommandMenu.FooterAction icon={SvgSearch} label="Search" />
                <CommandMenu.FooterAction
                  icon={SvgFileText}
                  label="Run action"
                />
              </>
            }
          />
        </CommandMenu.Content>
      </CommandMenu>
    </div>
  );
}
