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
