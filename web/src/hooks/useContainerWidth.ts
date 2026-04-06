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
