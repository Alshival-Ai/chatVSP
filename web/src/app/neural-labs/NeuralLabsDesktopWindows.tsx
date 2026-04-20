"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import Text from "@/refresh-components/texts/Text";
import NeuralLabsTooltip from "@/app/neural-labs/NeuralLabsTooltip";
import { SvgFold, SvgMaximize2, SvgX } from "@opal/icons";
import type {
  DesktopWindowState,
  PreviewSnapZone,
} from "@/app/neural-labs/types";

interface WorkspaceBounds {
  width: number;
  height: number;
}

interface NeuralLabsDesktopWindowsProps {
  windows: DesktopWindowState[];
  workspaceBounds: WorkspaceBounds;
  onCloseWindow: (windowId: string) => void;
  onFocusWindow: (windowId: string) => void;
  onMinimizeWindow: (windowId: string) => void;
  onUpdateWindow: (
    windowId: string,
    update:
      | Partial<DesktopWindowState>
      | ((windowState: DesktopWindowState) => DesktopWindowState)
  ) => void;
  renderWindowContent: (windowState: DesktopWindowState) => ReactNode;
}

type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

interface DragInteraction {
  mode: "drag";
  pointerX: number;
  pointerY: number;
  windowState: DesktopWindowState;
}

interface ResizeInteraction {
  mode: "resize";
  pointerX: number;
  pointerY: number;
  direction: ResizeDirection;
  windowState: DesktopWindowState;
}

type InteractionState = DragInteraction | ResizeInteraction;

const SNAP_THRESHOLD = 28;
const WINDOW_GAP = 12;
const MIN_WINDOW_WIDTH = 420;
const MIN_WINDOW_HEIGHT = 280;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getSnappedBounds(
  zone: PreviewSnapZone,
  workspaceBounds: WorkspaceBounds
): Pick<DesktopWindowState, "x" | "y" | "width" | "height"> {
  const width = Math.max(
    MIN_WINDOW_WIDTH,
    Math.floor((workspaceBounds.width - WINDOW_GAP * 3) / 2)
  );
  const height = Math.max(
    MIN_WINDOW_HEIGHT,
    Math.floor((workspaceBounds.height - WINDOW_GAP * 3) / 2)
  );
  const fullWidth = Math.max(
    MIN_WINDOW_WIDTH,
    workspaceBounds.width - WINDOW_GAP * 2
  );
  const fullHeight = Math.max(
    MIN_WINDOW_HEIGHT,
    workspaceBounds.height - WINDOW_GAP * 2
  );
  const rightX = Math.max(
    WINDOW_GAP,
    workspaceBounds.width - width - WINDOW_GAP
  );
  const bottomY = Math.max(
    WINDOW_GAP,
    workspaceBounds.height - height - WINDOW_GAP
  );

  switch (zone) {
    case "left":
      return { x: WINDOW_GAP, y: WINDOW_GAP, width, height: fullHeight };
    case "right":
      return { x: rightX, y: WINDOW_GAP, width, height: fullHeight };
    case "top":
      return { x: WINDOW_GAP, y: WINDOW_GAP, width: fullWidth, height };
    case "bottom":
      return { x: WINDOW_GAP, y: bottomY, width: fullWidth, height };
    case "top-left":
      return { x: WINDOW_GAP, y: WINDOW_GAP, width, height };
    case "top-right":
      return { x: rightX, y: WINDOW_GAP, width, height };
    case "bottom-left":
      return { x: WINDOW_GAP, y: bottomY, width, height };
    case "bottom-right":
      return { x: rightX, y: bottomY, width, height };
  }
}

function getMaximizedBounds(
  workspaceBounds: WorkspaceBounds
): Pick<DesktopWindowState, "x" | "y" | "width" | "height"> {
  return {
    x: WINDOW_GAP,
    y: WINDOW_GAP,
    width: Math.max(MIN_WINDOW_WIDTH, workspaceBounds.width - WINDOW_GAP * 2),
    height: Math.max(
      MIN_WINDOW_HEIGHT,
      workspaceBounds.height - WINDOW_GAP * 2
    ),
  };
}

function clampWindowToWorkspace(
  windowState: DesktopWindowState,
  workspaceBounds: WorkspaceBounds
): DesktopWindowState {
  if (workspaceBounds.width <= 0 || workspaceBounds.height <= 0) {
    return windowState;
  }

  if (windowState.is_maximized) {
    return {
      ...windowState,
      ...getMaximizedBounds(workspaceBounds),
    };
  }

  if (windowState.snapped_zone) {
    return {
      ...windowState,
      ...getSnappedBounds(windowState.snapped_zone, workspaceBounds),
    };
  }

  const maxWidth = Math.max(
    MIN_WINDOW_WIDTH,
    workspaceBounds.width - WINDOW_GAP * 2
  );
  const maxHeight = Math.max(
    MIN_WINDOW_HEIGHT,
    workspaceBounds.height - WINDOW_GAP * 2
  );
  const width = clamp(windowState.width, MIN_WINDOW_WIDTH, maxWidth);
  const height = clamp(windowState.height, MIN_WINDOW_HEIGHT, maxHeight);
  const x = clamp(
    windowState.x,
    WINDOW_GAP,
    workspaceBounds.width - width - WINDOW_GAP
  );
  const y = clamp(
    windowState.y,
    WINDOW_GAP,
    workspaceBounds.height - height - WINDOW_GAP
  );

  return { ...windowState, x, y, width, height };
}

function detectSnapZone(
  x: number,
  y: number,
  width: number,
  height: number,
  workspaceBounds: WorkspaceBounds
): PreviewSnapZone | null {
  const nearLeft = x <= SNAP_THRESHOLD;
  const nearRight = x + width >= workspaceBounds.width - SNAP_THRESHOLD;
  const nearTop = y <= SNAP_THRESHOLD;
  const nearBottom = y + height >= workspaceBounds.height - SNAP_THRESHOLD;

  if (nearTop && nearLeft) {
    return "top-left";
  }
  if (nearTop && nearRight) {
    return "top-right";
  }
  if (nearBottom && nearLeft) {
    return "bottom-left";
  }
  if (nearBottom && nearRight) {
    return "bottom-right";
  }
  if (nearLeft) {
    return "left";
  }
  if (nearRight) {
    return "right";
  }
  if (nearTop) {
    return "top";
  }
  if (nearBottom) {
    return "bottom";
  }
  return null;
}

function DesktopWindow({
  windowState,
  workspaceBounds,
  onCloseWindow,
  onFocusWindow,
  onMinimizeWindow,
  onUpdateWindow,
  renderWindowContent,
}: {
  windowState: DesktopWindowState;
  workspaceBounds: WorkspaceBounds;
  onCloseWindow: (windowId: string) => void;
  onFocusWindow: (windowId: string) => void;
  onMinimizeWindow: (windowId: string) => void;
  onUpdateWindow: (
    windowId: string,
    update:
      | Partial<DesktopWindowState>
      | ((windowState: DesktopWindowState) => DesktopWindowState)
  ) => void;
  renderWindowContent: (windowState: DesktopWindowState) => ReactNode;
}) {
  const [interaction, setInteraction] = useState<InteractionState | null>(null);
  const interactionRef = useRef<InteractionState | null>(null);

  useEffect(() => {
    interactionRef.current = interaction;
  }, [interaction]);

  useEffect(() => {
    if (!interaction) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const currentInteraction = interactionRef.current;
      if (!currentInteraction) {
        return;
      }

      const deltaX = event.clientX - currentInteraction.pointerX;
      const deltaY = event.clientY - currentInteraction.pointerY;

      if (currentInteraction.mode === "drag") {
        onUpdateWindow(currentInteraction.windowState.id, (existingWindow) => {
          const nextWindow = {
            ...existingWindow,
            x: existingWindow.x + deltaX,
            y: existingWindow.y + deltaY,
            snapped_zone: null,
            is_maximized: false,
            restore_bounds: null,
          };
          return clampWindowToWorkspace(nextWindow, workspaceBounds);
        });
        interactionRef.current = {
          ...currentInteraction,
          pointerX: event.clientX,
          pointerY: event.clientY,
          windowState: {
            ...currentInteraction.windowState,
            x: currentInteraction.windowState.x + deltaX,
            y: currentInteraction.windowState.y + deltaY,
            snapped_zone: null,
            is_maximized: false,
            restore_bounds: null,
          },
        };
        return;
      }

      const { windowState: activeWindow, direction } = currentInteraction;
      let nextX = activeWindow.x;
      let nextY = activeWindow.y;
      let nextWidth = activeWindow.width;
      let nextHeight = activeWindow.height;

      if (direction.includes("e")) {
        nextWidth = clamp(
          activeWindow.width + deltaX,
          MIN_WINDOW_WIDTH,
          Math.max(
            MIN_WINDOW_WIDTH,
            workspaceBounds.width - activeWindow.x - WINDOW_GAP
          )
        );
      }
      if (direction.includes("s")) {
        nextHeight = clamp(
          activeWindow.height + deltaY,
          MIN_WINDOW_HEIGHT,
          Math.max(
            MIN_WINDOW_HEIGHT,
            workspaceBounds.height - activeWindow.y - WINDOW_GAP
          )
        );
      }
      if (direction.includes("w")) {
        const candidateX = clamp(
          activeWindow.x + deltaX,
          WINDOW_GAP,
          activeWindow.x + activeWindow.width - MIN_WINDOW_WIDTH
        );
        nextWidth = activeWindow.width - (candidateX - activeWindow.x);
        nextX = candidateX;
      }
      if (direction.includes("n")) {
        const candidateY = clamp(
          activeWindow.y + deltaY,
          WINDOW_GAP,
          activeWindow.y + activeWindow.height - MIN_WINDOW_HEIGHT
        );
        nextHeight = activeWindow.height - (candidateY - activeWindow.y);
        nextY = candidateY;
      }

      const nextWindow = clampWindowToWorkspace(
        {
          ...activeWindow,
          x: nextX,
          y: nextY,
          width: nextWidth,
          height: nextHeight,
          snapped_zone: null,
          is_maximized: false,
          restore_bounds: null,
        },
        workspaceBounds
      );

      onUpdateWindow(activeWindow.id, nextWindow);
      interactionRef.current = {
        ...currentInteraction,
        pointerX: event.clientX,
        pointerY: event.clientY,
        windowState: nextWindow,
      };
    };

    const handlePointerUp = () => {
      const currentInteraction = interactionRef.current;
      if (!currentInteraction) {
        return;
      }

      if (currentInteraction.mode === "drag") {
        onUpdateWindow(currentInteraction.windowState.id, (existingWindow) => {
          const snapZone = detectSnapZone(
            existingWindow.x,
            existingWindow.y,
            existingWindow.width,
            existingWindow.height,
            workspaceBounds
          );

          if (!snapZone) {
            return existingWindow;
          }

          return {
            ...existingWindow,
            snapped_zone: snapZone,
            ...getSnappedBounds(snapZone, workspaceBounds),
          };
        });
      }

      setInteraction(null);
      interactionRef.current = null;
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [interaction, onUpdateWindow, workspaceBounds]);

  const beginDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      activeWindow: DesktopWindowState
    ) => {
      if (event.button !== 0 || activeWindow.is_maximized) {
        return;
      }

      event.preventDefault();
      onFocusWindow(activeWindow.id);
      setInteraction({
        mode: "drag",
        pointerX: event.clientX,
        pointerY: event.clientY,
        windowState: activeWindow,
      });
    },
    [onFocusWindow]
  );

  const beginResize = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      activeWindow: DesktopWindowState,
      direction: ResizeDirection
    ) => {
      if (event.button !== 0 || activeWindow.is_maximized) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onFocusWindow(activeWindow.id);
      setInteraction({
        mode: "resize",
        pointerX: event.clientX,
        pointerY: event.clientY,
        direction,
        windowState: activeWindow,
      });
    },
    [onFocusWindow]
  );

  const toggleMaximize = useCallback(
    (activeWindow: DesktopWindowState) => {
      onUpdateWindow(activeWindow.id, (existingWindow) => {
        if (existingWindow.is_maximized) {
          const restoreBounds = existingWindow.restore_bounds;
          if (!restoreBounds) {
            return {
              ...existingWindow,
              is_maximized: false,
              restore_bounds: null,
              snapped_zone: null,
            };
          }

          return clampWindowToWorkspace(
            {
              ...existingWindow,
              x: restoreBounds.x,
              y: restoreBounds.y,
              width: restoreBounds.width,
              height: restoreBounds.height,
              snapped_zone: restoreBounds.snapped_zone,
              is_maximized: false,
              restore_bounds: null,
            },
            workspaceBounds
          );
        }

        return {
          ...existingWindow,
          is_maximized: true,
          restore_bounds: {
            x: existingWindow.x,
            y: existingWindow.y,
            width: existingWindow.width,
            height: existingWindow.height,
            snapped_zone: existingWindow.snapped_zone,
          },
          snapped_zone: null,
          ...getMaximizedBounds(workspaceBounds),
        };
      });
    },
    [onUpdateWindow, workspaceBounds]
  );

  const resizeHandles: Array<{
    direction: ResizeDirection;
    className: string;
  }> = useMemo(
    () => [
      { direction: "n", className: "left-3 right-3 top-0 h-2 cursor-n-resize" },
      {
        direction: "ne",
        className: "right-0 top-0 h-3 w-3 cursor-ne-resize",
      },
      {
        direction: "e",
        className: "bottom-3 right-0 top-3 w-2 cursor-e-resize",
      },
      {
        direction: "se",
        className: "bottom-0 right-0 h-3 w-3 cursor-se-resize",
      },
      {
        direction: "s",
        className: "bottom-0 left-3 right-3 h-2 cursor-s-resize",
      },
      {
        direction: "sw",
        className: "bottom-0 left-0 h-3 w-3 cursor-sw-resize",
      },
      {
        direction: "w",
        className: "bottom-3 left-0 top-3 w-2 cursor-w-resize",
      },
      {
        direction: "nw",
        className: "left-0 top-0 h-3 w-3 cursor-nw-resize",
      },
    ],
    []
  );

  return (
    <div
      className="absolute overflow-hidden rounded-[26px] border border-white/20 bg-[#0c111d]/88 shadow-[0_30px_80px_rgba(5,10,20,0.45)] backdrop-blur-xl"
      style={{
        left: windowState.x,
        top: windowState.y,
        width: windowState.width,
        height: windowState.height,
        zIndex: windowState.z_index,
      }}
      onMouseDown={() => onFocusWindow(windowState.id)}
    >
      <div
        className={`flex h-full flex-col ${
          windowState.is_maximized ? "rounded-none" : ""
        }`}
      >
        <div
          className={`grid h-12 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-4 ${
            windowState.is_maximized ? "cursor-default" : "cursor-move"
          }`}
          onDoubleClick={(event: ReactMouseEvent<HTMLDivElement>) => {
            if (event.button !== 0) {
              return;
            }
            toggleMaximize(windowState);
          }}
          onPointerDown={(event) => beginDrag(event, windowState)}
        >
          <div className="flex items-center gap-2">
            <NeuralLabsTooltip label="Close window">
              <button
                type="button"
                className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#ff6b6b] transition hover:brightness-110"
                onClick={() => onCloseWindow(windowState.id)}
              >
                <SvgX className="h-2.5 w-2.5 stroke-[#6b1010]" />
              </button>
            </NeuralLabsTooltip>
            <NeuralLabsTooltip label="Minimize window">
              <button
                type="button"
                className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#f6be4f] transition hover:brightness-110"
                onClick={() => onMinimizeWindow(windowState.id)}
              />
            </NeuralLabsTooltip>
            <NeuralLabsTooltip
              label={
                windowState.is_maximized ? "Restore window" : "Maximize window"
              }
            >
              <button
                type="button"
                className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-[#35c95e] transition hover:brightness-110"
                onClick={() => toggleMaximize(windowState)}
              >
                {windowState.is_maximized ? (
                  <SvgFold className="h-2.5 w-2.5 stroke-[#0d4b1f]" />
                ) : (
                  <SvgMaximize2 className="h-2.5 w-2.5 stroke-[#0d4b1f]" />
                )}
              </button>
            </NeuralLabsTooltip>
          </div>
          <div className="min-w-0 justify-self-center pr-8">
            <Text className="truncate text-sm font-medium text-white">
              {windowState.title}
            </Text>
          </div>
        </div>

        <div className="min-h-0 flex-1 bg-[#0a0f1a]/80">
          {renderWindowContent(windowState)}
        </div>
      </div>

      {!windowState.is_maximized
        ? resizeHandles.map((handle) => (
            <div
              key={handle.direction}
              className={`absolute ${handle.className}`}
              onPointerDown={(event) =>
                beginResize(event, windowState, handle.direction)
              }
            />
          ))
        : null}
    </div>
  );
}

export default function NeuralLabsDesktopWindows({
  windows,
  workspaceBounds,
  onCloseWindow,
  onFocusWindow,
  onMinimizeWindow,
  onUpdateWindow,
  renderWindowContent,
}: NeuralLabsDesktopWindowsProps) {
  return (
    <>
      {windows
        .filter((windowState) => !windowState.is_minimized)
        .map((windowState) => (
          <DesktopWindow
            key={windowState.id}
            windowState={windowState}
            workspaceBounds={workspaceBounds}
            onCloseWindow={onCloseWindow}
            onFocusWindow={onFocusWindow}
            onMinimizeWindow={onMinimizeWindow}
            onUpdateWindow={onUpdateWindow}
            renderWindowContent={renderWindowContent}
          />
        ))}
    </>
  );
}
