import { useCallback } from "react";

interface Options {
  /** body cursor while dragging. Default: ns-resize. */
  cursor?: string;
}

/**
 * Imperative drag-listener template. Wraps the
 * "mousedown → window mousemove → window mouseup" boilerplate including
 * body.cursor + user-select clearing on cleanup. The caller's mousedown
 * handler captures whatever start-state it needs (startY, startH, etc.)
 * in a closure and passes an `onMove(e)` that consumes it.
 *
 * Returns a single `start(e, onMove)` function — call it from inside a
 * React mousedown handler.
 */
export function useDragResize() {
  return useCallback(
    (e: React.MouseEvent, onMove: (ev: MouseEvent) => void, opts?: Options) => {
      e.preventDefault();
      const cursor = opts?.cursor ?? "ns-resize";
      const cleanup = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", cleanup);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";
    },
    [],
  );
}
