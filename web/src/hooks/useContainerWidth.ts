import { useCallback, useRef, useState } from "react";

/**
 * Track a mounted element's content-box size via ResizeObserver. Returns
 * a callback ref + current width/height. ResizeObserver entries are the
 * authoritative source — clientWidth/Height can be stale or zero on
 * freshly-mounted flex items in some Chrome builds.
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
