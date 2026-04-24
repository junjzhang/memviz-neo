import { useRef, useState, useEffect, useCallback } from "react";

export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  const update = useCallback(() => {
    if (ref.current) setWidth(ref.current.clientWidth);
  }, []);

  useEffect(() => {
    update();
    const ro = new ResizeObserver(update);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [update]);

  return [ref, width];
}

/**
 * Like useContainerWidth but also tracks height. Use when a child canvas
 * needs to be sized to a flex-sized parent (e.g. PhaseTimeline inside a
 * flex:1 pane that shrinks as the bottom tray grows).
 *
 * Reads sizes from ResizeObserver entries (contentRect) rather than
 * clientWidth/clientHeight — clientWidth can be stale or zero for
 * freshly-mounted flex items in some Chrome builds; the observer entry
 * is authoritative.
 */
export function useContainerSize<T extends HTMLElement = HTMLDivElement>(): [
  (el: T | null) => void,
  number,
  number,
] {
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const roRef = useRef<ResizeObserver | null>(null);
  const setRef = useCallback((el: T | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) {
      setSize((prev) => (prev.w === 0 && prev.h === 0 ? prev : { w: 0, h: 0 }));
      return;
    }
    const rect = el.getBoundingClientRect();
    setSize({ w: rect.width, h: rect.height });
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize((prev) =>
          prev.w === width && prev.h === height ? prev : { w: width, h: height },
        );
      }
    });
    ro.observe(el);
    roRef.current = ro;
  }, []);

  return [setRef, size.w, size.h];
}

/**
 * Viewport height minus the room the header + section chrome reserves,
 * clamped to a minimum so the plot stays usable on short windows.
 *
 *   min       — floor to return on tiny viewports.
 *   reserved  — px to subtract (header + section head + bottom padding).
 */
export function useViewportHeight(min: number, reserved: number): number {
  const compute = () =>
    Math.max(min, Math.floor((typeof window !== "undefined" ? window.innerHeight : min + reserved) - reserved));
  const [h, setH] = useState(compute);
  useEffect(() => {
    const on = () => setH(compute());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [min, reserved]); // eslint-disable-line react-hooks/exhaustive-deps
  return h;
}
