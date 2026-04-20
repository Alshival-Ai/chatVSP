"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import Text from "@/refresh-components/texts/Text";
import NeuralLabsTooltip from "@/app/neural-labs/NeuralLabsTooltip";
import { SvgFold, SvgMaximize2, SvgX } from "@opal/icons";
import type { DesktopWindowState } from "@/app/neural-labs/types";

interface WorkspaceBounds {
  width: number;
  height: number;
}

interface NeuralLabsDesktopWindowsProps {
  windows: DesktopWindowState[];
  workspaceBounds: WorkspaceBounds;
  onCloseWindow: (windowId: string) => void;
  onFocusWindow: (windowId: string) => void;
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

const WINDOW_GAP = 12;
const MIN_WINDOW_WIDTH = 420;
const MIN_WINDOW_HEIGHT = 280;
const RESIZE_HANDLE_SIZE = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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

export default function NeuralLabsDesktopWindows({
  windows,
  workspaceBounds,
  onCloseWindow,
  onFocusWindow,
  onUpdateWindow,
  renderWindowContent,
}: NeuralLabsDesktopWindowsProps) {
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
        const maxX = Math.max(
          WINDOW_GAP,
          workspaceBounds.width - currentInteraction.windowState.width
        );
        const maxY = Math.max(
          WINDOW_GAP,
          workspaceBounds.height - currentInteraction.windowState.height
        );

        onUpdateWindow(currentInteraction.windowState.id, {
          x: clamp(currentInteraction.windowState.x + deltaX, WINDOW_GAP, maxX),
          y: clamp(currentInteraction.windowState.y + deltaY, WINDOW_GAP, maxY),
        });
        return;
      }

      const { windowState, direction } = currentInteraction;
      let nextX = windowState.x;
      let nextY = windowState.y;
      let nextWidth = windowState.width;
      let nextHeight = windowState.height;

      if (direction.includes("e")) {
        nextWidth = clamp(
          windowState.width + deltaX,
          MIN_WINDOW_WIDTH,
          Math.max(
            MIN_WINDOW_WIDTH,
            workspaceBounds.width - windowState.x - WINDOW_GAP
          )
        );
      }
      if (direction.includes("s")) {
        nextHeight = clamp(
          windowState.height + deltaY,
          MIN_WINDOW_HEIGHT,
          Math.max(
            MIN_WINDOW_HEIGHT,
            workspaceBounds.height - windowState.y - WINDOW_GAP
          )
        );
      }
      if (direction.includes("w")) {
        const candidateX = clamp(
          windowState.x + deltaX,
          WINDOW_GAP,
          windowState.x + windowState.width - MIN_WINDOW_WIDTH
        );
        nextWidth = windowState.width - (candidateX - windowState.x);
        nextX = candidateX;
      }
      if (direction.includes("n")) {
        const candidateY = clamp(
          windowState.y + deltaY,
          WINDOW_GAP,
          windowState.y + windowState.height - MIN_WINDOW_HEIGHT
        );
        nextHeight = windowState.height - (candidateY - windowState.y);
        nextY = candidateY;
      }

      onUpdateWindow(windowState.id, {
        x: nextX,
        y: nextY,
        width: nextWidth,
        height: nextHeight,
      });
    };

    const clearInteraction = () => setInteraction(null);

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", clearInteraction);
    window.addEventListener("pointercancel", clearInteraction);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", clearInteraction);
      window.removeEventListener("pointercancel", clearInteraction);
    };
  }, [
    interaction,
    onUpdateWindow,
    workspaceBounds.height,
    workspaceBounds.width,
  ]);

  const beginDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      windowState: DesktopWindowState
    ) => {
      if (event.button !== 0 || windowState.is_maximized) {
        return;
      }

      event.preventDefault();
      onFocusWindow(windowState.id);
      setInteraction({
        mode: "drag",
        pointerX: event.clientX,
        pointerY: event.clientY,
        windowState,
      });
    },
    [onFocusWindow]
  );

  const beginResize = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      windowState: DesktopWindowState,
      direction: ResizeDirection
    ) => {
      if (event.button !== 0 || windowState.is_maximized) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onFocusWindow(windowState.id);
      setInteraction({
        mode: "resize",
        pointerX: event.clientX,
        pointerY: event.clientY,
        direction,
        windowState,
      });
    },
    [onFocusWindow]
  );

  const toggleMaximize = useCallback(
    (windowState: DesktopWindowState) => {
      if (windowState.is_maximized && windowState.restore_bounds) {
        onUpdateWindow(windowState.id, {
          ...windowState.restore_bounds,
          is_maximized: false,
          restore_bounds: null,
        });
        return;
      }

      onUpdateWindow(windowState.id, {
        ...getMaximizedBounds(workspaceBounds),
        is_maximized: true,
        restore_bounds: {
          x: windowState.x,
          y: windowState.y,
          width: windowState.width,
          height: windowState.height,
        },
      });
    },
    [onUpdateWindow, workspaceBounds]
  );

  return (
    <>
      {windows.map((windowState) => (
        <div
          key={windowState.id}
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
              className={`flex items-center justify-between border-b border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] px-4 py-3 ${
                windowState.is_maximized ? "cursor-default" : "cursor-move"
              }`}
              onPointerDown={(event) => beginDrag(event, windowState)}
            >
              <div className="min-w-0 pr-4">
                <Text className="truncate text-sm font-medium text-white">
                  {windowState.title}
                </Text>
              </div>
              <div className="flex items-center gap-1">
                <NeuralLabsTooltip
                  label={
                    windowState.is_maximized
                      ? "Restore window"
                      : "Maximize window"
                  }
                >
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/6 hover:bg-white/12"
                    onClick={() => toggleMaximize(windowState)}
                  >
                    {windowState.is_maximized ? (
                      <SvgFold className="h-4 w-4 stroke-white" />
                    ) : (
                      <SvgMaximize2 className="h-4 w-4 stroke-white" />
                    )}
                  </button>
                </NeuralLabsTooltip>
                <NeuralLabsTooltip label="Close window">
                  <button
                    type="button"
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/6 hover:bg-[#ff6b6b]/15"
                    onClick={() => onCloseWindow(windowState.id)}
                  >
                    <SvgX className="h-4 w-4 stroke-white" />
                  </button>
                </NeuralLabsTooltip>
              </div>
            </div>

            <div className="min-h-0 flex-1 bg-[#0a0f1a]/80">
              {renderWindowContent(windowState)}
            </div>
          </div>

          {!windowState.is_maximized ? (
            <>
              {(
                [
                  "n",
                  "ne",
                  "e",
                  "se",
                  "s",
                  "sw",
                  "w",
                  "nw",
                ] as ResizeDirection[]
              ).map((direction) => {
                const positionClass =
                  direction === "n"
                    ? "left-4 right-4 top-0 h-[10px] cursor-n-resize"
                    : direction === "ne"
                      ? "right-0 top-0 h-[14px] w-[14px] cursor-ne-resize"
                      : direction === "e"
                        ? "bottom-4 right-0 top-4 w-[10px] cursor-e-resize"
                        : direction === "se"
                          ? "bottom-0 right-0 h-[14px] w-[14px] cursor-se-resize"
                          : direction === "s"
                            ? "bottom-0 left-4 right-4 h-[10px] cursor-s-resize"
                            : direction === "sw"
                              ? "bottom-0 left-0 h-[14px] w-[14px] cursor-sw-resize"
                              : direction === "w"
                                ? "bottom-4 left-0 top-4 w-[10px] cursor-w-resize"
                                : "left-0 top-0 h-[14px] w-[14px] cursor-nw-resize";

                return (
                  <div
                    key={direction}
                    className={`absolute ${positionClass}`}
                    style={{
                      touchAction: "none",
                      margin: -RESIZE_HANDLE_SIZE / 2,
                    }}
                    onPointerDown={(event) =>
                      beginResize(event, windowState, direction)
                    }
                  />
                );
              })}
            </>
          ) : null}
        </div>
      ))}
    </>
  );
}
