"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import Text from "@/refresh-components/texts/Text";
import type {
  TerminalLayoutState,
  TerminalPaneState,
  TerminalTabState,
} from "@/app/neural-labs/types";
import {
  SvgChevronDown,
  SvgChevronRight,
  SvgCopy,
  SvgEdit,
  SvgPlus,
  SvgTerminal,
  SvgX,
} from "@opal/icons";

const CONTEXT_MENU_MARGIN_PX = 8;

type TerminalContextMenuScope = "strip" | "tab";

interface TerminalContextMenuState {
  scope: TerminalContextMenuScope;
  tab_id: string | null;
  x: number;
  y: number;
}

interface NeuralLabsDesktopTerminalProps {
  layout: TerminalLayoutState | null;
  isInitializing: boolean;
  onAddTab: () => Promise<void> | void;
  onSetActiveTab: (tabId: string) => void;
  onSetActivePane: (tabId: string, paneId: string) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onClosePane: (tabId: string, paneId: string) => Promise<void> | void;
  onSplitTab: (
    tabId: string,
    direction: "horizontal" | "vertical"
  ) => Promise<void> | void;
  onDuplicateTab: (tabId: string) => Promise<void> | void;
  onRenameTab: (tabId: string) => void;
  onMoveTabToNewWindow: (tabId: string) => void;
  onReorderTabs: (sourceTabId: string, targetTabId: string) => void;
  renderTerminalPane: (
    pane: TerminalPaneState,
    isActive: boolean,
    onFocus: () => void
  ) => ReactNode;
}

function reorderTabs(
  tabs: TerminalTabState[],
  sourceTabId: string,
  targetTabId: string
): TerminalTabState[] {
  if (sourceTabId === targetTabId) {
    return tabs;
  }

  const sourceIndex = tabs.findIndex((tab) => tab.tab_id === sourceTabId);
  const targetIndex = tabs.findIndex((tab) => tab.tab_id === targetTabId);
  if (sourceIndex === -1 || targetIndex === -1) {
    return tabs;
  }

  const nextTabs = [...tabs];
  const [movedTab] = nextTabs.splice(sourceIndex, 1);
  if (!movedTab) {
    return tabs;
  }

  nextTabs.splice(targetIndex, 0, movedTab);
  return nextTabs;
}

export default function NeuralLabsDesktopTerminal({
  layout,
  isInitializing,
  onAddTab,
  onSetActiveTab,
  onSetActivePane,
  onCloseTab,
  onClosePane,
  onSplitTab,
  onDuplicateTab,
  onRenameTab,
  onMoveTabToNewWindow,
  onReorderTabs,
  renderTerminalPane,
}: NeuralLabsDesktopTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenuState, setContextMenuState] =
    useState<TerminalContextMenuState | null>(null);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);

  const activeTab = useMemo(() => {
    if (!layout) {
      return null;
    }

    return (
      layout.tabs.find((tab) => tab.tab_id === layout.active_tab_id) ??
      layout.tabs[0] ??
      null
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

  const canSplitActiveTab = Boolean(activeTab && activeTab.panes.length === 1);
  const contextMenuTab = useMemo(() => {
    if (!contextMenuState?.tab_id || !layout) {
      return null;
    }

    return (
      layout.tabs.find((tab) => tab.tab_id === contextMenuState.tab_id) ?? null
    );
  }, [contextMenuState, layout]);

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

  const openContextMenu = (
    event: ReactMouseEvent<HTMLElement>,
    scope: TerminalContextMenuScope,
    tabId: string | null
  ) => {
    event.preventDefault();
    event.stopPropagation();

    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) {
      return;
    }

    setContextMenuState({
      scope,
      tab_id: tabId,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  };

  const handleTabDrop = (
    event: ReactDragEvent<HTMLElement>,
    targetTabId: string
  ) => {
    event.preventDefault();
    event.stopPropagation();

    if (draggedTabId && draggedTabId !== targetTabId) {
      onReorderTabs(draggedTabId, targetTabId);
    }
    setDraggedTabId(null);
  };

  const renderMenuAction = ({
    label,
    icon,
    onClick,
    destructive = false,
    disabled = false,
  }: {
    label: string;
    icon?: ReactNode;
    onClick: () => void;
    destructive?: boolean;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      className={`flex w-full items-center gap-2 rounded-12 px-3 py-2 text-left text-sm transition ${
        disabled
          ? "cursor-not-allowed text-white/30"
          : destructive
            ? "text-red-300 hover:bg-red-500/10"
            : "text-white/85 hover:bg-white/10"
      }`}
      disabled={disabled}
      onClick={() => {
        if (disabled) {
          return;
        }
        onClick();
        setContextMenuState(null);
      }}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={containerRef}
      className="relative flex h-full min-h-0 flex-col bg-[linear-gradient(180deg,#0f1218_0%,#0a0c11_100%)] text-white"
    >
      <div className="border-b border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))]">
        <div
          className="flex items-end gap-1 overflow-x-auto px-3 pt-3"
          onContextMenu={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest("[data-terminal-tab='true']")) {
              return;
            }
            openContextMenu(event, "strip", null);
          }}
          onDoubleClick={(event) => {
            if (event.target === event.currentTarget) {
              void onAddTab();
            }
          }}
        >
          {(layout?.tabs ?? []).map((tab, index) => {
            const isActive = tab.tab_id === activeTab?.tab_id;
            return (
              <div
                key={tab.tab_id}
                role="button"
                tabIndex={0}
                data-terminal-tab="true"
                draggable
                className={`group relative flex min-w-[11rem] max-w-[15rem] items-center gap-2 rounded-t-[1rem] border border-b-0 px-3 py-2 text-left transition ${
                  isActive
                    ? "border-white/12 bg-[#171b23] text-white"
                    : "border-transparent bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white/80"
                }`}
                onClick={() => onSetActiveTab(tab.tab_id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSetActiveTab(tab.tab_id);
                  }
                }}
                onContextMenu={(event) =>
                  openContextMenu(event, "tab", tab.tab_id)
                }
                onMouseDown={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    void onCloseTab(tab.tab_id);
                  }
                }}
                onDragStart={(event) => {
                  setDraggedTabId(tab.tab_id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", tab.tab_id);
                }}
                onDragOver={(event) => {
                  if (draggedTabId && draggedTabId !== tab.tab_id) {
                    event.preventDefault();
                  }
                }}
                onDrop={(event) => handleTabDrop(event, tab.tab_id)}
                onDragEnd={() => setDraggedTabId(null)}
              >
                <SvgTerminal
                  className={`h-4 w-4 shrink-0 ${
                    isActive ? "stroke-white" : "stroke-current"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <Text className="truncate text-sm">
                    {tab.title || `Terminal ${index + 1}`}
                  </Text>
                </div>
                <button
                  type="button"
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition ${
                    isActive
                      ? "text-white/65 hover:bg-white/10 hover:text-white"
                      : "text-white/35 hover:bg-white/10 hover:text-white/80"
                  }`}
                  onClick={(event) => {
                    event.stopPropagation();
                    void onCloseTab(tab.tab_id);
                  }}
                >
                  <SvgX className="h-3.5 w-3.5 stroke-current" />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/70 transition hover:bg-white/[0.1] hover:text-white"
            aria-label="New terminal tab"
            onClick={() => void onAddTab()}
          >
            <SvgPlus className="h-4 w-4 stroke-current" />
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <div className="min-w-0">
            <Text className="truncate text-sm text-white/85">
              {activeTab
                ? `${activeTab.title}${
                    activePane ? ` · ${activePane.terminal_id.slice(0, 8)}` : ""
                  }`
                : "Terminal"}
            </Text>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={`rounded-full px-3 py-1.5 text-sm transition ${
                canSplitActiveTab
                  ? "bg-white/[0.08] text-white/80 hover:bg-white/[0.12]"
                  : "cursor-not-allowed bg-white/[0.04] text-white/30"
              }`}
              disabled={!canSplitActiveTab || !activeTab}
              onClick={() => {
                if (activeTab) {
                  void onSplitTab(activeTab.tab_id, "vertical");
                }
              }}
            >
              Split Right
            </button>
            <button
              type="button"
              className={`rounded-full px-3 py-1.5 text-sm transition ${
                canSplitActiveTab
                  ? "bg-white/[0.08] text-white/80 hover:bg-white/[0.12]"
                  : "cursor-not-allowed bg-white/[0.04] text-white/30"
              }`}
              disabled={!canSplitActiveTab || !activeTab}
              onClick={() => {
                if (activeTab) {
                  void onSplitTab(activeTab.tab_id, "horizontal");
                }
              }}
            >
              Split Down
            </button>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0b0d12]">
        {isInitializing ? (
          <div className="flex h-full items-center justify-center p-4">
            <Text className="text-sm text-white/60">
              Initializing terminal window…
            </Text>
          </div>
        ) : !layout || layout.tabs.length === 0 || !activeTab ? (
          <div className="flex h-full items-center justify-center p-4">
            <Text className="text-sm text-white/60">
              No terminal tabs are open.
            </Text>
          </div>
        ) : activeTab.split_mode === "none" ? (
          <div
            className="h-full min-h-0 p-3"
            onMouseDown={() =>
              activePane &&
              onSetActivePane(activeTab.tab_id, activePane.pane_id)
            }
          >
            <div className="h-full overflow-hidden rounded-[1.2rem] border border-white/10 bg-black shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              {activePane
                ? renderTerminalPane(activePane, true, () =>
                    onSetActivePane(activeTab.tab_id, activePane.pane_id)
                  )
                : null}
            </div>
          </div>
        ) : (
          <div
            className={`grid h-full min-h-0 gap-3 p-3 ${
              activeTab.split_mode === "vertical"
                ? "grid-cols-2"
                : "grid-rows-2"
            }`}
          >
            {activeTab.panes.map((pane, index) => {
              const isActivePane = pane.pane_id === activePane?.pane_id;
              return (
                <div
                  key={pane.pane_id}
                  className={`flex min-h-0 flex-col overflow-hidden rounded-[1.2rem] border bg-black transition ${
                    isActivePane
                      ? "border-cyan-400/55 shadow-[0_0_0_1px_rgba(34,211,238,0.18)]"
                      : "border-white/10"
                  }`}
                  onMouseDown={() =>
                    onSetActivePane(activeTab.tab_id, pane.pane_id)
                  }
                >
                  <div className="flex items-center justify-between border-b border-white/10 bg-white/[0.04] px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <SvgTerminal className="h-3.5 w-3.5 shrink-0 stroke-white/60" />
                      <Text className="truncate text-xs uppercase tracking-[0.16em] text-white/55">
                        Pane {index + 1}
                      </Text>
                    </div>
                    <button
                      type="button"
                      className="flex h-6 w-6 items-center justify-center rounded-full text-white/45 transition hover:bg-white/10 hover:text-white/80"
                      onClick={(event) => {
                        event.stopPropagation();
                        void onClosePane(activeTab.tab_id, pane.pane_id);
                      }}
                    >
                      <SvgX className="h-3.5 w-3.5 stroke-current" />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1">
                    {renderTerminalPane(pane, isActivePane, () =>
                      onSetActivePane(activeTab.tab_id, pane.pane_id)
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-white/10 bg-black/20 px-3 py-2">
        <Text className="text-xs text-white/45">
          Right-click a tab for split, rename, duplicate, and move actions.
        </Text>
        <Text className="text-xs text-white/35">
          {layout?.tabs.length ?? 0} tab{layout?.tabs.length === 1 ? "" : "s"}
        </Text>
      </div>

      {contextMenuState ? (
        <div
          ref={contextMenuRef}
          className="absolute z-30 min-w-[14rem] overflow-hidden rounded-16 border border-white/10 bg-[#111722]/96 p-1.5 shadow-[0_24px_56px_rgba(0,0,0,0.45)] backdrop-blur-xl"
          style={{ left: contextMenuState.x, top: contextMenuState.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextMenuState.scope === "tab" && contextMenuTab ? (
            <>
              {renderMenuAction({
                label: "Split tab right",
                icon: <SvgChevronRight className="h-4 w-4 stroke-current" />,
                disabled: contextMenuTab.panes.length > 1,
                onClick: () =>
                  void onSplitTab(contextMenuTab.tab_id, "vertical"),
              })}
              {renderMenuAction({
                label: "Split tab down",
                icon: <SvgChevronDown className="h-4 w-4 stroke-current" />,
                disabled: contextMenuTab.panes.length > 1,
                onClick: () =>
                  void onSplitTab(contextMenuTab.tab_id, "horizontal"),
              })}
              {renderMenuAction({
                label: "Duplicate tab",
                icon: <SvgCopy className="h-4 w-4 stroke-current" />,
                onClick: () => void onDuplicateTab(contextMenuTab.tab_id),
              })}
              {renderMenuAction({
                label: "Rename tab",
                icon: <SvgEdit className="h-4 w-4 stroke-current" />,
                onClick: () => onRenameTab(contextMenuTab.tab_id),
              })}
              {renderMenuAction({
                label: "Move tab to new window",
                icon: <SvgTerminal className="h-4 w-4 stroke-current" />,
                onClick: () => onMoveTabToNewWindow(contextMenuTab.tab_id),
              })}
              {renderMenuAction({
                label: "Close",
                icon: <SvgX className="h-4 w-4 stroke-current" />,
                destructive: true,
                onClick: () => void onCloseTab(contextMenuTab.tab_id),
              })}
            </>
          ) : (
            <>
              {renderMenuAction({
                label: "New tab",
                icon: <SvgPlus className="h-4 w-4 stroke-current" />,
                onClick: () => void onAddTab(),
              })}
              {renderMenuAction({
                label: "Split active tab right",
                icon: <SvgChevronRight className="h-4 w-4 stroke-current" />,
                disabled: !activeTab || activeTab.panes.length > 1,
                onClick: () => {
                  if (activeTab) {
                    void onSplitTab(activeTab.tab_id, "vertical");
                  }
                },
              })}
              {renderMenuAction({
                label: "Split active tab down",
                icon: <SvgChevronDown className="h-4 w-4 stroke-current" />,
                disabled: !activeTab || activeTab.panes.length > 1,
                onClick: () => {
                  if (activeTab) {
                    void onSplitTab(activeTab.tab_id, "horizontal");
                  }
                },
              })}
              {renderMenuAction({
                label: "Rename active tab",
                icon: <SvgEdit className="h-4 w-4 stroke-current" />,
                disabled: !activeTab,
                onClick: () => {
                  if (activeTab) {
                    onRenameTab(activeTab.tab_id);
                  }
                },
              })}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
