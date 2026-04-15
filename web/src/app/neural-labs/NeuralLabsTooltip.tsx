"use client";

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Text from "@/refresh-components/texts/Text";

const VIEWPORT_PADDING_PX = 8;
const TOOLTIP_OFFSET_PX = 8;

export default function NeuralLabsTooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<any>;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [position, setPosition] = useState({ top: -9999, left: -9999 });
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!isVisible || !anchorRef.current || !tooltipRef.current) {
      return;
    }

    const anchorRect = anchorRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();

    const maxLeft =
      window.innerWidth - tooltipRect.width - VIEWPORT_PADDING_PX;
    const centeredLeft =
      anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
    const left = Math.min(
      Math.max(VIEWPORT_PADDING_PX, centeredLeft),
      Math.max(VIEWPORT_PADDING_PX, maxLeft)
    );

    const preferredTop = anchorRect.bottom + TOOLTIP_OFFSET_PX;
    const aboveTop = anchorRect.top - tooltipRect.height - TOOLTIP_OFFSET_PX;
    const top =
      preferredTop + tooltipRect.height + VIEWPORT_PADDING_PX <= window.innerHeight
        ? preferredTop
        : Math.max(VIEWPORT_PADDING_PX, aboveTop);

    setPosition({ top, left });
  }, [isVisible, label]);

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex"
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
        onFocusCapture={() => setIsVisible(true)}
        onBlurCapture={() => setIsVisible(false)}
      >
        {children as ReactNode}
      </span>
      {isMounted && isVisible
        ? createPortal(
            <div
              ref={tooltipRef}
              className="pointer-events-none fixed z-[10000] rounded-08 border border-border-01 bg-background-neutral-00 px-2 py-1 shadow-md"
              style={{
                top: `${position.top}px`,
                left: `${position.left}px`,
                maxWidth: `calc(100vw - ${VIEWPORT_PADDING_PX * 2}px)`,
              }}
            >
              <Text text03 className="whitespace-nowrap text-xs">
                {label}
              </Text>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
